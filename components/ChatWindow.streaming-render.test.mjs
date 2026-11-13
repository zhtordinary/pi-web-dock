import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/navigation") {
      return {
        url: "data:text/javascript,export%20const%20useRouter%20%3D%20()%20%3D%3E%20(%7B%20replace()%20%7B%7D%20%7D)%3B",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  },
});

const jiti = createJiti(import.meta.url, {
  alias: { "next/navigation": fileURLToPath(new URL("./ChatWindow.streaming-render.next-navigation.mjs", import.meta.url)) },
  fsCache: false,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const SESSION_ID = "stream-render-benchmark";
const HISTORY_USER_ID = "history-user";
const HISTORY_ASSISTANT_ID = "history-assistant";

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const session = {
  id: SESSION_ID,
  path: "/tmp/stream-render-benchmark.jsonl",
  cwd: "/tmp/stream-render-project",
  name: "Streaming render benchmark",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 2,
  firstMessage: "historical user message",
};

const metadata = {
  metadataOnly: true,
  sessionId: SESSION_ID,
  filePath: session.path,
  tree: [],
  leafId: null,
  context: {
    messages: [],
    entryIds: [],
    thinkingLevel: "auto",
    model: null,
  },
  toolNames: [],
  fastMode: "default",
};

const historyPage = {
  kind: "window",
  sessionId: SESSION_ID,
  leafId: null,
  revision: "benchmark-revision",
  totalMessages: 2,
  firstUserEntryId: HISTORY_USER_ID,
  lastUserEntryId: HISTORY_USER_ID,
  nodeCount: 2,
  nodeOffset: 0,
  before: null,
  after: null,
  coverage: { start: true, end: true },
  items: [
    {
      entryId: HISTORY_USER_ID,
      orderKey: [0, 0, 0],
      role: "user",
      sourceType: "message",
      messageIndex: 0,
      turnAnchor: { entryId: HISTORY_USER_ID, messageIndex: 0, questionIndex: 0, preview: "historical user message" },
      message: { role: "user", content: "historical user message", timestamp: 1 },
      contentState: "full",
      process: false,
      toolCallCount: 0,
      deferred: [],
    },
    {
      entryId: HISTORY_ASSISTANT_ID,
      orderKey: [1, 0, 0],
      role: "assistant",
      sourceType: "message",
      messageIndex: 1,
      turnAnchor: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "historical assistant message" }],
        timestamp: 2,
        provider: "fixture",
        model: "fixture-model",
        stopReason: "stop",
      },
      contentState: "full",
      process: false,
      toolCallCount: 0,
      deferred: [],
    },
  ],
};

const idleState = {
  running: true,
  state: {
    isStreaming: false,
    isPromptRunning: false,
    isBashRunning: false,
    isCompacting: false,
    autoCompactionEnabled: true,
    branchPosition: { leafId: null, pending: false },
    contextUsage: null,
    model: null,
    thinkingLevel: "auto",
  },
};

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() { return body; },
  };
}

class ControlledEventSource {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url) {
    this.url = String(url);
    this.readyState = ControlledEventSource.CONNECTING;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    ControlledEventSource.instances.push(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = ControlledEventSource.OPEN;
      this.emit({
        type: "connected",
        sessionId: SESSION_ID,
        runtimeAvailable: true,
        pendingExtensionUiIds: [],
      });
    });
  }

  emit(event) {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close() {
    this.closed = true;
    this.readyState = ControlledEventSource.CLOSED;
  }
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://reader.test/" });
  const previous = new Map();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLIFrameElement: dom.window.HTMLIFrameElement,
    Text: dom.window.Text,
    Document: dom.window.Document,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    DOMException: dom.window.DOMException,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const raf = (callback) => setTimeout(() => callback(performance.now()), 0);
  const caf = (id) => clearTimeout(id);
  dom.window.requestAnimationFrame = raf;
  dom.window.cancelAnimationFrame = caf;
  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = caf;
  dom.window.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  dom.window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  dom.window.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  globalThis.ResizeObserver = dom.window.ResizeObserver;
  globalThis.IntersectionObserver = dom.window.IntersectionObserver;
  return () => {
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

test("real composer isolates same-id peers and copies ambiguous legacy drafts only on request", async () => {
  const restoreDom = installDom();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: window.localStorage });
  globalThis.fetch = async () => response({});
  const store = await jiti.import("../lib/draft-store.ts");
  const { ChatInput } = await jiti.import("./ChatInput.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const id = "legacy-draft-ownership-test";
  const peerA = store.sessionDraftKey(id, "peer-a");
  const peerB = store.sessionDraftKey(id, "peer-b");
  const oldEditKey = store.legacyHistoryDraftKey(id, "peer-a");
  const edit = { entryId: "original-entry", clientMessageId: "pending-client" };
  store.setDraft(id, { value: "ambiguous old text", images: [], quotes: [{ id: "quote-1", text: "old quote" }] });
  store.setDraft(oldEditKey, { value: "", images: [], historyEdit: edit });
  const recovered = [];
  const inputRef = React.createRef();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const renderPeer = async (peer) => React.act(async () => {
    root.render(React.createElement(I18nProvider, { initialLocale: "en" },
      React.createElement(ChatInput, { key: peer, ref: inputRef, onSend() {}, onAbort() {}, isStreaming: false,
        sessionId: id, remotePeer: peer, draftKey: store.sessionDraftKey(id, peer), onLegacyDraftRecovered: value => recovered.push(value) })));
    await tick();
  });
  try {
    await renderPeer("peer-a");
    assert.equal(container.querySelector("textarea")?.value, "", "unowned drafts must not load automatically");
    assert.ok(container.textContent.includes("may belong to another device"));
    const recover = container.querySelector("[data-legacy-draft-recover]");
    assert.ok(recover && !recover.disabled);
    await React.act(async () => { recover.click(); await tick(); });
    assert.equal(container.querySelector("textarea")?.value, "ambiguous old text");
    assert.deepEqual(recovered, [edit]);
    assert.equal(store.getDraft(peerA).historyEdit, undefined, "composer content must not own the in-flight edit identity");
    assert.equal(store.getDraft(peerA).quotes[0].text, "old quote");
    assert.equal(store.getDraft(id).value, "ambiguous old text", "copying must leave the original untouched");
    assert.deepEqual(store.getDraft(oldEditKey).historyEdit, edit);

    await renderPeer("peer-b");
    assert.equal(container.querySelector("textarea")?.value, "", "a different peer must not see peer A's draft");
    await React.act(async () => { inputRef.current.insertText("peer B text"); await tick(); });
    assert.equal(container.querySelector("textarea")?.value, "peer B text");
    assert.equal(container.querySelector("[data-legacy-draft-recover]")?.disabled, true, "recovery cannot overwrite current input");
    assert.equal(store.getDraft(peerB).value, "peer B text");
    await renderPeer("peer-a");
    assert.equal(container.querySelector("textarea")?.value, "ambiguous old text");
    assert.equal(JSON.parse(localStorage.getItem(store.draftKeyIdentity(peerB))).value, "peer B text");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    for (const key of [id, oldEditKey, peerA, peerB]) store.clearDraft(key);
    container.remove();
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage;
    restoreDom();
  }
});

test("production ChatWindow isolates 100 streaming deltas to StreamingReply in real DOM", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  const previousWindowEventSource = window.EventSource;
  const requests = [];
  globalThis.EventSource = ControlledEventSource;
  window.EventSource = ControlledEventSource;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.includes(`/sessions/${SESSION_ID}/history?`)) return response(historyPage);
    if (url.endsWith(`/sessions/${SESSION_ID}/state`)) return response(idleState);
    if (url.includes(`/sessions/${SESSION_ID}?`)) return response(metadata);
    if (url.includes(`/agent/${SESSION_ID}`) && init?.method === "POST") return response({ success: true, data: [] });
    if (url.includes(`/agent/${SESSION_ID}`)) return response({ running: false, state: idleState.state });
    if (url.includes("/models")) return response({ models: [] });
    if (url.includes("/cost")) return response({});
    return response({});
  };

  const { ChatWindow } = await jiti.import("./ChatWindow.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const counts = new Map();
  const probe = (component, entryId, streaming) => {
    const key = component === "MessageView"
      ? `${streaming ? "streaming" : "history"}:${entryId ?? "unknown"}`
      : component;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(
        I18nProvider,
        { initialLocale: "en" },
        React.createElement(ChatWindow, {
          session,
          sessionRunning: false,
          newSessionCwd: null,
          newSessionDraftKey: null,
          onOpenFile() {},
          renderProbe: probe,
        }),
      ));
      await tick();
      await tick();
    });

    await waitFor(
      () => container.querySelector(`[data-entry-id="${HISTORY_USER_ID}"]`) && container.querySelector(`[data-entry-id="${HISTORY_ASSISTANT_ID}"]`),
      "production ChatWindow did not mount both historical messages",
    );
    const eventSource = ControlledEventSource.instances.at(-1);
    assert.ok(eventSource, "production useAgentSession did not create an EventSource");
    assert.match(container.textContent, /historical user message/);
    assert.match(container.textContent, /historical assistant message/);

    await React.act(async () => {
      eventSource.emit({ type: "agent_start", runId: "benchmark-run" });
      eventSource.emit({
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "seed " }],
          timestamp: 3,
          provider: "fixture",
          model: "fixture-model",
        },
      });
      await tick();
    });
    await waitFor(() => container.querySelector('[data-chat-message-row="true"]')?.textContent?.includes("historical"), "streaming state did not stabilize");
    // Prime the production live-tail selector once; the post-prime base is the
    // stable state from which the independently counted 100 deltas begin.
    await React.act(async () => {
      eventSource.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "prime " } });
      await tick();
    });
    await React.act(async () => {
      await tick();
      await tick();
      await tick();
      await tick();
    });
    const before = new Map(counts);
    const chunks = Array.from({ length: 100 }, (_, index) => `delta-${String(index + 1).padStart(3, "0")} `);
    for (const delta of chunks) {
      await React.act(async () => {
        eventSource.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
        await tick();
      });
    }

    const increment = (key) => (counts.get(key) ?? 0) - (before.get(key) ?? 0);
    assert.equal(increment("ChatWindow"), 0, "ChatWindow must not re-render for text deltas");
    assert.equal(increment(`history:${HISTORY_USER_ID}`), 0, "user history must not re-render for text deltas");
    assert.equal(increment(`history:${HISTORY_ASSISTANT_ID}`), 0, "assistant history must not re-render for text deltas");
    assert.equal(increment("StreamingReply"), 100, "StreamingReply must render once per completed text delta");
    assert.equal(increment("streaming:unknown"), 100, "the streaming MessageView must follow StreamingReply exactly");
    const streamedText = chunks.join("");
    assert.match(container.textContent, new RegExp(streamedText.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(container.textContent, /historical user message/);
    assert.match(container.textContent, /historical assistant message/);
    assert.equal(requests.some(({ url }) => url.includes("/history?mode=window")), true, "history must come from the production transcript reader");
    console.log(JSON.stringify({
      command: "bash deployment/reader-release.sh verify components/ChatWindow.streaming-render.test.mjs",
      commit: currentCommit(),
      baseline: Object.fromEntries(before),
      increments: Object.fromEntries([...counts.keys()].map((key) => [key, increment(key)])),
      deltas: 100,
    }));
  } finally {
    await React.act(async () => {
      root.unmount();
      await tick();
    });
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    window.EventSource = previousWindowEventSource;
    restoreDom();
  }
});

test("production ChatWindow probe observes a real prop rerender on the same mounted instance", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  const previousWindowEventSource = window.EventSource;
  globalThis.EventSource = ControlledEventSource;
  window.EventSource = ControlledEventSource;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(`/sessions/${SESSION_ID}/history?`)) return response(historyPage);
    if (url.endsWith(`/sessions/${SESSION_ID}/state`)) return response(idleState);
    if (url.includes(`/sessions/${SESSION_ID}?`)) return response(metadata);
    if (url.includes(`/agent/${SESSION_ID}`) && init?.method === "POST") return response({ success: true, data: [] });
    if (url.includes(`/agent/${SESSION_ID}`)) return response({ running: false, state: idleState.state });
    if (url.includes("/models")) return response({ models: [] });
    if (url.includes("/cost")) return response({});
    return response({});
  };

  const { ChatWindow } = await jiti.import("./ChatWindow.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const counts = new Map();
  const probe = (component, entryId, streaming) => {
    const key = component === "MessageView"
      ? `${streaming ? "streaming" : "history"}:${entryId ?? "unknown"}`
      : component;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (sessionRunning) => React.createElement(
    I18nProvider,
    { initialLocale: "en" },
    React.createElement(ChatWindow, {
      session,
      sessionRunning,
      newSessionCwd: null,
      newSessionDraftKey: null,
      onOpenFile() {},
      renderProbe: probe,
    }),
  );
  try {
    await React.act(async () => {
      root.render(render(false));
      await tick();
      await tick();
    });
    await waitFor(
      () => container.querySelector(`[data-entry-id="${HISTORY_USER_ID}"]`) && container.querySelector(`[data-entry-id="${HISTORY_ASSISTANT_ID}"]`),
      "production ChatWindow did not mount both historical messages",
    );
    const userNode = container.querySelector(`[data-entry-id="${HISTORY_USER_ID}"]`);
    const assistantNode = container.querySelector(`[data-entry-id="${HISTORY_ASSISTANT_ID}"]`);
    const before = new Map(counts);

    await React.act(async () => {
      // This changes the production session prop; it does not call the probe,
      // unmount ChatWindow, or manufacture a second comparison instance.
      root.render(render(true));
      await tick();
      await tick();
    });
    await waitFor(
      () => container.querySelector(`[data-entry-id="${HISTORY_USER_ID}"]`) && container.querySelector(`[data-entry-id="${HISTORY_ASSISTANT_ID}"]`),
      "historical messages disappeared during the prop rerender",
    );
    const increment = (key) => (counts.get(key) ?? 0) - (before.get(key) ?? 0);
    assert.ok(increment("ChatWindow") > 0, "ChatWindow probe must observe the real prop rerender");
    assert.ok(increment(`history:${HISTORY_USER_ID}`) > 0, "user history MessageView must observe the real prop rerender");
    assert.ok(increment(`history:${HISTORY_ASSISTANT_ID}`) > 0, "assistant history MessageView must observe the real prop rerender");
    assert.strictEqual(container.querySelector(`[data-entry-id="${HISTORY_USER_ID}"]`), userNode, "user history must remain mounted");
    assert.strictEqual(container.querySelector(`[data-entry-id="${HISTORY_ASSISTANT_ID}"]`), assistantNode, "assistant history must remain mounted");
    assert.match(container.textContent, /historical user message/);
    assert.match(container.textContent, /historical assistant message/);
    console.log(JSON.stringify({
      command: "bash deployment/reader-release.sh verify components/ChatWindow.streaming-render.test.mjs",
      commit: currentCommit(),
      increments: Object.fromEntries([...counts.keys()].map((key) => [key, increment(key)])),
      sameMountedInstance: true,
    }));
  } finally {
    await React.act(async () => {
      root.unmount();
      await tick();
    });
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    window.EventSource = previousWindowEventSource;
    restoreDom();
  }
});

test("accepted draft promotion preserves the in-flight reply until the next delta", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  const previousWindowEventSource = window.EventSource;
  globalThis.EventSource = ControlledEventSource;
  window.EventSource = ControlledEventSource;
  let resolvePrompt;
  const runtimeState = { ...idleState.state, branchPosition: { leafId: null, pending: false } };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/agent/new")) return response({ sessionId: SESSION_ID, autoCompactionEnabled: true });
    if (url.includes(`/agent/${SESSION_ID}`) && init?.method === "POST") {
      const command = JSON.parse(init.body);
      if (command.type === "prompt") return new Promise((resolve) => { resolvePrompt = resolve; });
      if (command.type === "get_tools") return response({ success: true, data: [] });
      return response({ success: true, data: runtimeState });
    }
    if (url.includes(`/sessions/${SESSION_ID}/history?`)) return response(historyPage);
    if (url.endsWith(`/sessions/${SESSION_ID}/state`)) return response({ running: false, state: runtimeState });
    if (url.includes(`/sessions/${SESSION_ID}?`)) return response(metadata);
    if (url.includes(`/agent/${SESSION_ID}`)) return response({ running: false, state: runtimeState });
    if (url.includes("/models")) return response({ models: [] });
    return response({});
  };
  const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
  const { useStreamingSelector, selectStreamingMessage } = await jiti.import("../hooks/useStreamingSelector.ts");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const current = { agent: null, promoted: false };
  function LiveReply({ store }) {
    const message = useStreamingSelector(store, selectStreamingMessage);
    return React.createElement("div", { "data-live-reply": "" }, message?.content?.[0]?.text ?? "");
  }
  function Harness() {
    const [selected, setSelected] = React.useState(null);
    const agent = useAgentSession({
      session: selected,
      sessionRunning: false,
      newSessionCwd: selected ? null : "/tmp/stream-render-project",
      newSessionDraftKey: selected ? null : "promotion-draft",
      onSessionCreated: (created) => { current.promoted = true; setSelected(created); },
    });
    current.agent = agent;
    return React.createElement(LiveReply, { store: agent.streamingStore });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (key) => React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(Harness, { key }));
  let send;
  try {
    await React.act(async () => { root.render(render("draft")); await tick(); });
    await React.act(async () => { send = current.agent.handleSend("hello"); await tick(); });
    await waitFor(() => resolvePrompt, "the real hook did not send its prompt");
    const source = ControlledEventSource.instances.at(-1);
    assert.ok(source, "the real hook must connect to its event stream");
    await React.act(async () => {
      source.emit({ type: "agent_start", runId: "promotion-run" });
      source.emit({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 3, provider: "fixture", model: "fixture-model" } });
      source.emit({ type: "extension_ui_request", id: "pending-dialog", method: "confirm", title: "Permission", message: "Continue?" });
      source.emit({ type: "extension_ui_request", id: "pending-custom", method: "custom", title: "Custom UI" });
      source.emit({ type: "tool_execution_update", toolCallId: "tool-before-promotion", toolName: "bash", partialResult: { content: [{ type: "text", text: "working" }] } });
      await tick();
    });
    assert.equal(container.querySelector("[data-live-reply]").textContent, "before");
    assert.equal(current.agent.extensionDialog?.id, "pending-dialog");
    assert.equal(current.agent.extensionCustomUi?.id, "pending-custom");
    assert.equal(current.agent.activeToolResults.get("tool-before-promotion")?.content[0]?.text, "working");
    const liveStore = current.agent.streamingStore;
    await React.act(async () => { resolvePrompt(response({ success: true, data: { accepted: true } })); await send; await tick(); });
    assert.equal(current.promoted, true, "the production promotion callback must run");
    assert.strictEqual(current.agent.streamingStore, liveStore, "promotion must retain the running message's store");
    assert.equal(current.agent.extensionDialog?.id, "pending-dialog", "promotion must preserve an already received blocking dialog");
    assert.equal(current.agent.extensionCustomUi?.id, "pending-custom", "promotion must preserve custom UI");
    assert.equal(current.agent.activeToolResults.get("tool-before-promotion")?.content[0]?.text, "working", "promotion must preserve active tool output");
    await React.act(async () => {
      source.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " after" } });
      await tick();
    });
    assert.equal(container.querySelector("[data-live-reply]").textContent, "before after");
    await React.act(async () => { root.render(render("another-conversation")); await tick(); });
    assert.notStrictEqual(current.agent.streamingStore, liveStore, "a different keyed conversation must not reuse the old store");
    assert.equal(current.agent.streamingStore.getState().streamingMessage, null);
    assert.equal(source.closed, true, "unmount must close the previous conversation's stream");
  } finally {
    if (resolvePrompt) resolvePrompt(response({ success: true, data: { accepted: true } }));
    await React.act(async () => { root.unmount(); await tick(); });
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    window.EventSource = previousWindowEventSource;
    restoreDom();
  }
});

test("late bash completion from an unmounted draft cannot promote or rekey its replacement", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  let resolveBash;
  const runtimeState = { ...idleState.state, branchPosition: { leafId: null, pending: false } };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/agent/new")) return response({ sessionId: SESSION_ID, autoCompactionEnabled: true });
    if (url.includes(`/agent/${SESSION_ID}`) && init?.method === "POST") {
      const command = JSON.parse(init.body);
      if (command.type === "bash") return new Promise((resolve) => { resolveBash = resolve; });
      return response({ success: true, data: command.type === "get_tools" ? [] : runtimeState });
    }
    if (url.includes(`/sessions/${SESSION_ID}/history?`)) return response(historyPage);
    if (url.includes(`/sessions/${SESSION_ID}?`)) return response(metadata);
    if (url.includes("/models")) return response({ models: [] });
    return response({});
  };
  const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const calls = [];
  const inputRef = { current: { rekeyDraft: (...args) => calls.push(["old", ...args]), restoreSubmission() {} } };
  const state = { agent: null, promotions: [] };
  function Harness() {
    state.agent = useAgentSession({
      session: null, sessionRunning: false, newSessionCwd: "/tmp/stream-render-project", newSessionDraftKey: "late-bash-draft",
      chatInputRef: inputRef, onSessionCreated: (...args) => state.promotions.push(args),
    });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (key) => React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(Harness, { key }));
  let send;
  try {
    await React.act(async () => { root.render(render("old-draft")); await tick(); });
    await React.act(async () => { send = state.agent.handleSend("!pwd"); await tick(); });
    await waitFor(() => resolveBash, "the old draft did not start its shell command");
    await React.act(async () => { root.render(render("replacement-draft")); await tick(); });
    inputRef.current = { rekeyDraft: (...args) => calls.push(["replacement", ...args]), restoreSubmission: (...args) => calls.push(["restore", ...args]) };
    await React.act(async () => { resolveBash(response({ success: true, data: {} })); await send; await tick(); });
    assert.deepEqual(state.promotions, [], "a completed command from an unmounted owner must not promote");
    assert.deepEqual(calls, [], "a stale owner must not touch the replacement's shared input");
    assert.equal(state.agent.sessionIdRef.current, null);
  } finally {
    if (resolveBash) resolveBash(response({ success: true, data: {} }));
    await React.act(async () => { root.unmount(); await tick(); });
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("a manually recovered legacy historical edit still submits as edit_history", async () => {
  const restoreDom = installDom();
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldFetch = globalThis.fetch;
  const oldEventSource = globalThis.EventSource;
  const oldWindowEventSource = window.EventSource;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: window.localStorage });
  globalThis.EventSource = ControlledEventSource;
  window.EventSource = ControlledEventSource;
  const store = await jiti.import("../lib/draft-store.ts");
  const { ChatInput } = await jiti.import("./ChatInput.tsx");
  const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const peer = "peer-legacy-edit";
  const oldEditKey = store.legacyHistoryDraftKey(SESSION_ID, peer);
  const ownedKey = store.sessionDraftKey(SESSION_ID, peer);
  store.setDraft(SESSION_ID, { value: "recover my edit", images: [] });
  store.setDraft(oldEditKey, { value: "", images: [], historyEdit: { entryId: HISTORY_USER_ID, clientMessageId: "legacy-edit-client" } });
  const runtimeState = { ...idleState.state, branchPosition: { leafId: null, pending: false } };
  const commands = [];
  let resolveEdit;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(`/sessions/${SESSION_ID}/history?`)) return response(historyPage);
    if (url.includes(`/sessions/${SESSION_ID}/state`)) return response({ running: false, state: runtimeState });
    if (url.includes(`/sessions/${SESSION_ID}?`)) return response(metadata);
    if (url.includes(`/agent/${SESSION_ID}`) && init?.method === "POST") {
      const command = JSON.parse(init.body);
      commands.push(command);
      if (command.type === "edit_history") return new Promise((resolve) => { resolveEdit = resolve; });
      return response({ success: true, data: command.type === "get_tools" ? [] : runtimeState });
    }
    if (url.includes(`/agent/${SESSION_ID}`)) return response({ running: false, state: runtimeState });
    if (url.includes("/models")) return response({ models: [] });
    return response({});
  };
  const current = { agent: null };
  const inputRef = React.createRef();
  function Harness() {
    current.agent = useAgentSession({ session, sessionRunning: false, newSessionCwd: null, newSessionDraftKey: null, remotePeer: peer, chatInputRef: inputRef });
    return React.createElement(ChatInput, { ref: inputRef, onSend: current.agent.handleSend, onAbort() {}, isStreaming: false,
      sessionId: SESSION_ID, remotePeer: peer, draftKey: ownedKey, onLegacyDraftRecovered: current.agent.restoreLegacyHistoryEdit });
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await React.act(async () => { root.render(React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(Harness))); await tick(); await tick(); });
    await waitFor(() => !current.agent.sessionStatePending && current.agent.data, "the recovered edit owner did not load");
    await React.act(async () => { container.querySelector("[data-legacy-draft-recover]").click(); await tick(); });
    assert.equal(current.agent.editEntryId, HISTORY_USER_ID);
    assert.equal(container.querySelector("textarea")?.value, "recover my edit");
    await React.act(async () => { container.querySelector('button[aria-label="Send"]').click(); await tick(); });
    await waitFor(() => resolveEdit, "the recovered edit did not start");
    const sent = commands.find((command) => command.type === "edit_history");
    assert.equal(sent?.targetEntryId, HISTORY_USER_ID);
    assert.equal(sent?.clientMessageId, "legacy-edit-client");
    assert.equal(commands.some((command) => command.type === "prompt"), false);
    assert.equal(store.getDraft(store.historyDraftKey(SESSION_ID, peer))?.historyEdit?.entryId, HISTORY_USER_ID, "clearing the composer must not erase an unacknowledged edit");
    assert.equal(store.getDraft(SESSION_ID).value, "recover my edit");
    await React.act(async () => { resolveEdit(response({ success: true, data: { accepted: true, leafId: "edited-leaf" } })); await tick(); await tick(); });
    assert.equal(store.getDraft(store.historyDraftKey(SESSION_ID, peer))?.historyEdit, undefined, "the edit identity clears only after acknowledgement");
  } finally {
    if (resolveEdit) resolveEdit(response({ success: true, data: { accepted: true, leafId: "edited-leaf" } }));
    await React.act(async () => { root.unmount(); await tick(); });
    for (const key of [SESSION_ID, oldEditKey, ownedKey, store.historyDraftKey(SESSION_ID, peer)]) store.clearDraft(key);
    container.remove();
    globalThis.fetch = oldFetch;
    globalThis.EventSource = oldEventSource;
    window.EventSource = oldWindowEventSource;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage;
    restoreDom();
  }
});

test("historical edit acknowledgement preserves a reply that started before the acknowledgement", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  const previousWindowEventSource = window.EventSource;
  globalThis.EventSource = ControlledEventSource;
  window.EventSource = ControlledEventSource;
  let resolveEdit;
  const runtimeState = { ...idleState.state, branchPosition: { leafId: null, pending: false } };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(`/sessions/${SESSION_ID}/history?`)) return response(historyPage);
    if (url.endsWith(`/sessions/${SESSION_ID}/state`)) return response({ running: true, state: runtimeState });
    if (url.includes(`/sessions/${SESSION_ID}?`)) return response(metadata);
    if (url.includes(`/agent/${SESSION_ID}`) && init?.method === "POST") {
      const command = JSON.parse(init.body);
      if (command.type === "edit_history") return new Promise((resolve) => { resolveEdit = resolve; });
      if (command.type === "get_tools") return response({ success: true, data: [] });
      return response({ success: true, data: runtimeState });
    }
    if (url.includes(`/agent/${SESSION_ID}`)) return response({ running: true, state: runtimeState });
    if (url.includes("/models")) return response({ models: [] });
    return response({});
  };
  const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const current = { agent: null };
  const chatInputRef = { current: { replaceMessage: () => true, restoreSubmission() {} } };
  function Harness() {
    current.agent = useAgentSession({ session, sessionRunning: false, newSessionCwd: null, newSessionDraftKey: null, chatInputRef });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  let send;
  try {
    await React.act(async () => { root.render(React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(Harness))); await tick(); await tick(); });
    await waitFor(() => !current.agent.sessionStatePending && current.agent.data, "session metadata and runtime state did not load");
    await React.act(async () => {
      assert.equal(current.agent.handleEditContent({ role: "user", content: "historical user message" }, HISTORY_USER_ID), true);
      await tick();
    });
    await React.act(async () => { send = current.agent.handleSend("edited question"); await tick(); });
    await waitFor(() => resolveEdit, "the real hook did not issue edit_history");
    const source = ControlledEventSource.instances.at(-1);
    await React.act(async () => {
      source.emit({ type: "agent_start", runId: "edit-run" });
      source.emit({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 3, provider: "fixture", model: "fixture-model" } });
      await tick();
    });
    const liveStore = current.agent.streamingStore;
    assert.equal(liveStore.getState().streamingMessage.content[0].text, "before");
    await React.act(async () => { resolveEdit(response({ success: true, data: { accepted: true, leafId: "edited-leaf" } })); await send; await tick(); });
    assert.equal(current.agent.activeLeafId, "edited-leaf", "the real edit acknowledgement must update the selected leaf");
    assert.strictEqual(current.agent.streamingStore, liveStore, "a leaf acknowledgement must not discard the active stream");
    await React.act(async () => { source.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " after" } }); await tick(); });
    assert.equal(current.agent.streamingStore.getState().streamingMessage.content[0].text, "before after");
  } finally {
    if (resolveEdit) resolveEdit(response({ success: true, data: { accepted: true, leafId: "edited-leaf" } }));
    await React.act(async () => { root.unmount(); await tick(); });
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    window.EventSource = previousWindowEventSource;
    restoreDom();
  }
});

test("a late fork RPC from an unmounted session cannot navigate the new peer", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  const previousWindowEventSource = window.EventSource;
  globalThis.EventSource = ControlledEventSource;
  window.EventSource = ControlledEventSource;
  let resolveFork;
  const runtimeState = { ...idleState.state, branchPosition: { leafId: null, pending: false } };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(`/sessions/${SESSION_ID}/history?`)) return response(historyPage);
    if (url.includes(`/sessions/${SESSION_ID}/state`)) return response({ running: true, state: runtimeState });
    if (url.includes(`/sessions/${SESSION_ID}?`)) return response(metadata);
    if (url.includes(`/agent/${SESSION_ID}`) && init?.method === "POST") {
      const command = JSON.parse(init.body);
      if (command.type === "fork") return new Promise((resolve) => { resolveFork = resolve; });
      return response({ success: true, data: command.type === "get_tools" ? [] : runtimeState });
    }
    if (url.includes(`/agent/${SESSION_ID}`)) return response({ running: true, state: runtimeState });
    if (url.includes("/models")) return response({ models: [] });
    return response({});
  };
  const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const state = { agent: null, forks: [] };
  function Harness({ peer }) {
    state.agent = useAgentSession({ session, sessionRunning: false, newSessionCwd: null, newSessionDraftKey: null, remotePeer: peer, onSessionForked: (result) => state.forks.push(result) });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (peer) => React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(Harness, { key: peer, peer }));
  let fork;
  try {
    await React.act(async () => { root.render(render("peer-a")); await tick(); await tick(); });
    await waitFor(() => !state.agent.sessionStatePending, "the first peer did not load");
    await React.act(async () => { fork = state.agent.handleFork(HISTORY_USER_ID); await tick(); });
    await waitFor(() => resolveFork, "the old peer did not issue its fork RPC");
    await React.act(async () => { root.render(render("peer-b")); await tick(); });
    await React.act(async () => { resolveFork(response({ success: true, data: { newSessionId: "old-peer-fork" } })); await fork; await tick(); });
    assert.deepEqual(state.forks, [], "a stale fork must not notify the new session owner");
  } finally {
    if (resolveFork) resolveFork(response({ success: true, data: { newSessionId: "old-peer-fork" } }));
    await React.act(async () => { root.unmount(); await tick(); });
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    window.EventSource = previousWindowEventSource;
    restoreDom();
  }
});

async function mountLiveMinimap(atLiveTail, withToolTurn = false) {
  const { ChatMinimap } = await jiti.import("./ChatMinimap.tsx");
  const { createStreamingStore } = await jiti.import("../lib/streaming-message.ts");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const store = createStreamingStore();
  store.dispatch({ type: "snapshot", message: { role: "assistant", content: [{ type: "text", text: "initial live answer" }], timestamp: 3, provider: "fixture", model: "fixture-model" } });
  const scroll = document.createElement("div");
  const host = document.createElement("div");
  const row = document.createElement("div");
  row.dataset.chatMessageRow = "true";
  row.dataset.entryId = "question";
  host.appendChild(row);
  scroll.appendChild(host);
  document.body.appendChild(scroll);
  const scrollContainer = { current: scroll };
  const messageRefs = { current: [row] };
  const streamingMessageRef = { current: null };
  const messages = withToolTurn ? [
    { role: "user", content: "Earlier question", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], timestamp: 2 },
    { role: "user", content: "History question", timestamp: 3 },
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "tool-1", toolName: "read", input: {} }], timestamp: 4 },
    { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "done" }], timestamp: 5 },
  ] : [{ role: "user", content: "History question", timestamp: 1 }];
  const entryIds = withToolTurn ? ["earlier", "earlier-answer", "question", "tool-call", "tool-result"] : ["question"];
  const historyNodes = withToolTurn
    ? [{ entryId: "earlier", nodeIndex: 0, kind: "turn", preview: "Earlier question" }, { entryId: "question", nodeIndex: 1, kind: "turn", preview: "History question" }]
    : [{ entryId: "question", nodeIndex: 0, kind: "turn", preview: "History question" }];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (live) => React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(ChatMinimap, {
    messages, entryIds, historyNodes, historyNodeCount: historyNodes.length, scrollContainer, messageRefs, streamingMessageRef,
    streamingStore: store, atLiveTail: live,
    onReadHistory() {}, onScrollToEntry() {}, onScrollToBottom() {},
  }));
  await React.act(async () => { root.render(render(atLiveTail)); await tick(); await tick(); });
  await waitFor(() => container.querySelector("[data-minimap-node-index]"), "the minimap did not measure its visible node");
  const rail = container.querySelector("[data-minimap-bottom-actions]").parentElement;
  await React.act(async () => { rail.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); await tick(); });
  assert.ok(container.querySelector("[data-minimap-preview-box]"), "the real preview must be open");
  return { root, store, container, rerender: async (live) => React.act(async () => { root.render(render(live)); await tick(); }) };
}

test("minimap never attaches a live answer to a historical window", async () => {
  const restoreDom = installDom();
  let mounted;
  try {
    mounted = await mountLiveMinimap(false);
    assert.match(mounted.container.textContent, /History question/);
    assert.doesNotMatch(mounted.container.textContent, /initial live answer/);
    await mounted.rerender(true);
    await waitFor(() => mounted.container.textContent.includes("initial live answer"), "returning to the tail must show the live answer");
    await mounted.rerender(false);
    await waitFor(() => !mounted.container.textContent.includes("initial live answer"), "leaving the tail must remove the live answer");
  } finally {
    if (mounted) await React.act(async () => { mounted.root.unmount(); await tick(); });
    restoreDom();
  }
});

test("minimap associates the live answer after a tool with the latest user turn only", async () => {
  const restoreDom = installDom();
  let mounted;
  try {
    mounted = await mountLiveMinimap(true, true);
    const earlier = mounted.container.querySelector('[data-minimap-preview-index="0"]');
    const latest = mounted.container.querySelector('[data-minimap-preview-index="1"]');
    assert.ok(earlier && latest, "both user turns must be present");
    assert.match(earlier.textContent, /Earlier answer/);
    assert.doesNotMatch(earlier.textContent, /initial live answer/);
    assert.match(latest.textContent, /initial live answer/, "tool activity must not detach the current live reply from its question");
  } finally {
    if (mounted) await React.act(async () => { mounted.root.unmount(); await tick(); });
    restoreDom();
  }
});

test("visible minimap refreshes streamed text without any resize", async () => {
  const restoreDom = installDom();
  let mounted;
  try {
    mounted = await mountLiveMinimap(true);
    // Let the initial 50 ms layout bootstrap finish before sending the delta:
    // otherwise that unrelated timer can make a missing subscription look green.
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 90)); });
    assert.match(mounted.container.textContent, /initial live answer/);
    await React.act(async () => {
      mounted.store.dispatch({ type: "delta", event: { type: "text_delta", contentIndex: 0, delta: " updated" } });
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    assert.match(mounted.container.textContent, /initial live answer updated/);
  } finally {
    if (mounted) await React.act(async () => { mounted.root.unmount(); await tick(); });
    restoreDom();
  }
});

test("the real Sidekick drawer dismisses only its floating view on parent messages", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  const parent = { postMessage() {} };
  Object.defineProperty(window, "parent", { configurable: true, value: parent });
  globalThis.fetch = async () => response({ entries: [] });
  const { SidekickDrawer, SIDEKICK_RIGHT_PANEL_TARGET_ID } = await jiti.import("./SidekickDrawer.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const { EMBEDDED_SIDEKICK_DISMISS_EVENT } = await jiti.import("../lib/embedded-modal.ts");
  const target = document.createElement("div");
  target.id = SIDEKICK_RIGHT_PANEL_TARGET_ID;
  document.body.appendChild(target);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  let closed = 0;
  const render = (open, placement) => React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(SidekickDrawer, {
    sessionId: SESSION_ID, open, placement, onClose: () => { closed += 1; }, onQuoteToComposer() {},
  }));
  const emit = (source) => window.dispatchEvent(new window.MessageEvent("message", { source, data: { type: EMBEDDED_SIDEKICK_DISMISS_EVENT } }));
  try {
    await React.act(async () => { root.render(render(true, "sidebar")); await tick(); });
    await React.act(async () => { emit({}); emit(parent); await tick(); });
    assert.equal(closed, 1, "the floating drawer closes once and ignores other windows");
    await React.act(async () => { root.render(render(true, "right-panel")); await tick(); });
    await React.act(async () => { emit(parent); await tick(); });
    assert.equal(closed, 1, "the docked view ignores parent dismissal");
    await React.act(async () => { root.render(render(false, "sidebar")); await tick(); });
    await React.act(async () => { emit(parent); await tick(); });
    assert.equal(closed, 1, "a closed drawer ignores parent dismissal");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});

test("question analysis polls query-encoded remote entry and job IDs", async () => {
  const restoreDom = installDom();
  const previousFetch = globalThis.fetch;
  const requests = [];
  const job = { entryId: "question#1/?", jobId: "job#1/?", mode: "question", status: "running" };
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return response({ jobs: [{ ...job, status: "failed", error: "fixture failure" }] });
  };
  const { MessageView } = await jiti.import("./MessageView.tsx");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(MessageView, {
        message: { role: "user", content: "A question", timestamp: 1 },
        sessionId: SESSION_ID, entryId: job.entryId, remotePeer: "remote-device", questionAnalysisJob: job,
      })));
      await tick();
      await tick();
    });
    assert.equal(requests.length, 1, "a pending remote job must be polled");
    const request = new URL(requests[0], "http://reader.test");
    assert.equal(request.pathname, `/api/remote/sessions/${SESSION_ID}/question-analysis`);
    assert.equal(request.searchParams.get("entryId"), job.entryId);
    assert.equal(request.searchParams.get("jobId"), job.jobId);
    assert.equal(request.searchParams.get("peer"), "remote-device");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    globalThis.fetch = previousFetch;
    restoreDom();
  }
});
