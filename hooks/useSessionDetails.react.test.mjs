import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useSessionDetails } = await jiti.import("./useSessionDetails.ts");
const { I18nProvider } = await jiti.import("./useI18n.tsx");
const { SessionActivityMeta } = await jiti.import("../components/SessionActivityMeta.tsx");
const details = await jiti.import("../lib/session-details-client.ts");

class ReactDomNodeShim {
  constructor(ownerDocument, nodeName = "div") {
    this.ownerDocument = ownerDocument;
    this.nodeName = nodeName.toUpperCase();
    this.tagName = this.nodeName;
    this.nodeType = 1;
    this.nodeValue = null;
    this.childNodes = [];
    this.children = this.childNodes;
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
  }
  appendChild(node) { this.childNodes.push(node); node.parentNode = this; return node; }
  insertBefore(node, before) {
    const index = this.childNodes.indexOf(before);
    if (index < 0) return this.appendChild(node);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  focus() {}
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? String(child.nodeValue ?? "") : String(child.textContent ?? "")).join(""); }
  set textContent(value) {
    this.childNodes = [];
    if (value === null || value === undefined || value === "") return;
    const text = new ReactDomTextShim(this.ownerDocument, String(value));
    text.parentNode = this;
    this.childNodes.push(text);
  }
}

class ReactDomTextShim {
  constructor(ownerDocument, value) {
    this.ownerDocument = ownerDocument;
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentNode = null;
  }
}

class ReactDomDocumentShim {
  constructor() {
    this.nodeType = 9;
    this.defaultView = globalThis.window;
    this.documentElement = new ReactDomNodeShim(this, "html");
    this.body = new ReactDomNodeShim(this, "body");
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(name) { return new ReactDomNodeShim(this, name); }
  createElementNS(_namespace, name) { return new ReactDomNodeShim(this, name); }
  createTextNode(value) { return new ReactDomTextShim(this, value); }
  addEventListener() {}
  removeEventListener() {}
  getElementById() { return null; }
}

class ReactDomIFrameShim extends ReactDomNodeShim {}

function installReactDomShim() {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  globalThis.window = {};
  globalThis.window.HTMLIFrameElement = ReactDomIFrameShim;
  globalThis.window.HTMLElement = ReactDomNodeShim;
  globalThis.window.Node = ReactDomNodeShim;
  globalThis.window.Document = ReactDomDocumentShim;
  globalThis.window.location = { protocol: "http:" };
  globalThis.window.setInterval = globalThis.setInterval;
  globalThis.window.clearInterval = globalThis.clearInterval;
  globalThis.document = new ReactDomDocumentShim();
  globalThis.window.document = globalThis.document;
  globalThis.window.window = globalThis.window;
  globalThis.window.self = globalThis.window;
  globalThis.window.top = globalThis.window;
  globalThis.window.parent = globalThis.window;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node" },
    configurable: true,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return previous;
}

function restoreReactDomShim(previous) {
  if (previous.window === undefined) delete globalThis.window;
  else globalThis.window = previous.window;
  if (previous.document === undefined) delete globalThis.document;
  else globalThis.document = previous.document;
  if (previous.fetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previous.fetch;
  if (previous.actEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
  if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
  else delete globalThis.navigator;
}

function Probe({ sessionId, version = "v1", peer, deviceId, loadCost, onSnapshot }) {
  const { cost, costState } = useSessionDetails({
    sessionId,
    version,
    peer,
    deviceId,
    costView: "summary",
    loadCost,
  });
  React.useEffect(() => {
    onSnapshot({ sessionId, version, peer, deviceId, amount: cost?.amount ?? null, costState, cost });
  }, [cost, cost?.amount, costState, deviceId, onSnapshot, peer, sessionId, version]);
  return null;
}

function MetadataCostProbe({ onSnapshot }) {
  const detailsSnapshot = useSessionDetails({ sessionId: "metadata-session", version: "v1", costView: "summary", loadCost: true });
  const [metadata, setMetadata] = React.useState(null);
  React.useEffect(() => {
    void fetch("/api/sessions/metadata-session?metadataOnly=1").then((response) => response.json()).then(setMetadata);
  }, []);
  React.useEffect(() => {
    onSnapshot({ metadata, costState: detailsSnapshot.costState, cost: detailsSnapshot.cost });
  }, [detailsSnapshot.cost, detailsSnapshot.costState, metadata, onSnapshot]);
  return null;
}

function probes(specs, onSnapshot) {
  return specs.map(({ key, sessionId, loadCost }) => React.createElement(Probe, {
    key,
    sessionId,
    loadCost,
    onSnapshot,
  }));
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

function textContent(node) {
  if (node.nodeType === 3) return String(node.nodeValue ?? "");
  return (node.childNodes ?? []).map(textContent).join("");
}

test("SessionActivityMeta uses the automatic JSX runtime", () => {
  assert.doesNotMatch(SessionActivityMeta.toString(), /\bReact\.createElement/);
});

test("SessionActivityMeta renders loading, error and ready cost states", async () => {
  const previous = installReactDomShim();
  const originalFetch = globalThis.fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const responses = [];
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return new Promise((resolve) => responses.push({ resolve }));
  };
  const item = {
    device: { id: "device-a", name: "Fixture" },
    session: { id: "meta-render", path: "/tmp/meta-render.jsonl", cwd: "/tmp", created: "2026-01-01T00:00:00.000Z", modified: "v1", messageCount: 1, firstMessage: "fixture" },
    projectKey: "fixture",
    projectLabel: "Fixture",
    status: "idle",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    latestRun: null,
    runs: [],
  };
  const response = (ok, amount = null) => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => ({ amount, status: ok ? "calculated" : "unavailable" }),
  });
  try {
    await React.act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(SessionActivityMeta, { item, showStatus: false })));
      await tick();
      await tick();
    });
    assert.equal(calls, 1);
    assert.match(textContent(container), /…/, "a pending cost is rendered as loading");

    responses.shift().resolve(response(false));
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(calls, 1, "an error does not trigger an implicit retry loop");
    assert.match(textContent(container), /\?/, "an unavailable cost is rendered as an error marker");

    await React.act(async () => {
      details.invalidateSessionDetails({ sessionId: "meta-render", version: "v1", costView: "summary" });
      await tick(); await tick();
    });
    assert.equal(calls, 2, "the mounted production row re-requests after invalidation");
    assert.match(textContent(container), /…/);
    responses.shift().resolve(response(true, 1.25));
    await React.act(async () => { await tick(); await tick(); });
    assert.match(textContent(container), /\$1\.25/, "a ready cost replaces loading/error without a stale flash");
  } finally {
    for (const pending of responses.splice(0)) pending.resolve(response(false));
    await React.act(async () => { await tick(); await tick(); root.unmount(); await tick(); });
    details.clearSessionDetailsCache();
    globalThis.fetch = originalFetch;
    restoreReactDomShim(previous);
  }
});

test("shared queued summary survives one React consumer leaving and cancels after the last leaves", async () => {
  const previous = installReactDomShim();
  const originalFetch = globalThis.fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots = [];
  let calls = 0;
  let blockers = [];
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 4) await new Promise((resolve) => blockers.push(resolve));
    return { ok: true, status: 200, json: async () => ({ amount: calls, status: "calculated" }) };
  };
  const onSnapshot = (snapshot) => snapshots.push(snapshot);
  const placeholders = Array.from({ length: 4 }, (_, index) => ({
    key: `placeholder-${index}`,
    sessionId: `placeholder-${index}`,
    loadCost: true,
  }));
  const sharedA = [
    { key: "shared-a-1", sessionId: "shared-a", loadCost: true },
    { key: "shared-a-2", sessionId: "shared-a", loadCost: true },
  ];
  try {
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([...placeholders, ...sharedA], onSnapshot)));
      await tick();
    });
    assert.equal(calls, 4, "four active requests occupy the queue slots");

    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([
        ...placeholders,
        { key: "shared-a-1", sessionId: "shared-a", loadCost: false },
        { key: "shared-a-2", sessionId: "shared-a", loadCost: true },
      ], onSnapshot)));
      await tick();
    });
    assert.equal(calls, 4, "one leaving consumer must not cancel the shared queued request");

    for (const release of blockers) release();
    blockers = [];
    await React.act(async () => { await tick(); await tick(); });
    assert.ok(snapshots.some((entry) => entry.sessionId === "shared-a" && entry.amount === 5 && entry.costState === "ready"), "remaining visible consumer receives the shared result");
    assert.equal(calls, 5, "the shared request starts after the four blockers release");

    await React.act(async () => {
      root.render(null);
      await tick();
    });
    details.clearSessionDetailsCache();
    snapshots.length = 0;
    calls = 0;
    blockers = [];

    const sharedB = [
      { key: "shared-b-1", sessionId: "shared-b", loadCost: true },
      { key: "shared-b-2", sessionId: "shared-b", loadCost: true },
    ];
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([...placeholders, ...sharedB], onSnapshot)));
      await tick();
    });
    assert.equal(calls, 4);
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([
        ...placeholders,
        { key: "shared-b-2", sessionId: "shared-b", loadCost: true },
      ], onSnapshot)));
      await tick();
    });
    assert.equal(calls, 4, "the first exit leaves the second consumer waiting");
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes(placeholders, onSnapshot)));
      await tick();
    });
    for (const release of blockers) release();
    blockers = [];
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(calls, 4, "the last consumer exit cancels the still-queued request");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    details.clearSessionDetailsCache();
    globalThis.fetch = originalFetch;
    restoreReactDomShim(previous);
  }
});

test("mounted summary consumers re-fetch after invalidation and preserve last-consumer cancellation", async () => {
  const previous = installReactDomShim();
  const originalFetch = globalThis.fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots = [];
  let calls = 0;
  let blockers = [];
  const deferred = [];
  const response = (amount) => ({ ok: true, status: 200, json: async () => ({ amount, status: "calculated" }) });
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 4) {
      await new Promise((resolve) => blockers.push(resolve));
      return response(calls);
    }
    if (calls === 6 || calls === 7) return new Promise((resolve) => deferred.push({ calls, resolve }));
    return response(calls);
  };
  const onSnapshot = (snapshot) => snapshots.push(snapshot);
  const placeholders = Array.from({ length: 4 }, (_, index) => ({
    key: `invalidate-placeholder-${index}`,
    sessionId: `invalidate-placeholder-${index}`,
    loadCost: true,
  }));
  const shared = [
    { key: "invalidate-shared-1", sessionId: "invalidate-shared", loadCost: true },
    { key: "invalidate-shared-2", sessionId: "invalidate-shared", loadCost: true },
  ];
  const request = { sessionId: "invalidate-shared", version: "v1", costView: "summary" };
  try {
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([...placeholders, ...shared], onSnapshot)));
      await tick();
    });
    assert.equal(calls, 4);

    details.invalidateSessionDetails(request);
    await React.act(async () => { await tick(); });
    assert.equal(calls, 4, "invalidation replaces the queued request without starting past the concurrency limit");
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([
        ...placeholders,
        { key: "invalidate-shared-1", sessionId: "invalidate-shared", loadCost: true },
        { key: "invalidate-shared-2", sessionId: "invalidate-shared", loadCost: true },
      ], onSnapshot)));
      await tick();
    });
    for (const release of blockers.splice(0)) release();
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(calls, 5, "the invalidated mounted summary starts after the four placeholders");
    assert.ok(snapshots.filter((entry) => entry.sessionId === "invalidate-shared").some((entry) => entry.amount === 5 && entry.costState === "ready"));

    details.invalidateSessionDetails(request);
    await React.act(async () => { await tick(); });
    assert.equal(calls, 6);
    details.invalidateSessionDetails(request);
    await React.act(async () => { await tick(); });
    assert.equal(calls, 7, "a second invalidation starts a newer generation without reusing the active request");
    deferred.find((entry) => entry.calls === 6).resolve(response(6));
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(calls, 7);
    deferred.find((entry) => entry.calls === 7).resolve(response(7));
    await React.act(async () => { await tick(); await tick(); });
    const sharedSnapshots = snapshots.filter((entry) => entry.sessionId === "invalidate-shared");
    assert.equal(sharedSnapshots.some((entry) => entry.amount === 6), false, "the old in-flight response cannot overwrite the newer generation");
    assert.ok(sharedSnapshots.some((entry) => entry.amount === 7 && entry.costState === "ready"));

    await React.act(async () => { root.render(null); await tick(); });
    details.clearSessionDetailsCache();
    snapshots.length = 0;
    calls = 0;
    blockers = [];
    deferred.length = 0;
    const sharedB = [
      { key: "invalidate-shared-b-1", sessionId: "invalidate-shared-b", loadCost: true },
      { key: "invalidate-shared-b-2", sessionId: "invalidate-shared-b", loadCost: true },
    ];
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([...placeholders, ...sharedB], onSnapshot)));
      await tick();
    });
    assert.equal(calls, 4);
    details.invalidateSessionDetails({ sessionId: "invalidate-shared-b", version: "v1", costView: "summary" });
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, probes([
        ...placeholders,
        { key: "invalidate-shared-b-2", sessionId: "invalidate-shared-b", loadCost: true },
      ], onSnapshot)));
      await tick();
    });
    await React.act(async () => { root.render(React.createElement(React.Fragment, null, probes(placeholders, onSnapshot))); await tick(); });
    for (const release of blockers.splice(0)) release();
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(calls, 4, "only the final consumer leaving cancels the refreshed queued summary");
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    details.clearSessionDetailsCache();
    globalThis.fetch = originalFetch;
    restoreReactDomShim(previous);
  }
});

test("metadata stats become visible before a delayed Reader cost and retain separate scopes", async () => {
  const previous = installReactDomShim();
  const originalFetch = globalThis.fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots = [];
  let resolveMetadata;
  let resolveCost;
  globalThis.fetch = (url) => new Promise((resolve) => {
    if (String(url).includes("metadataOnly=1")) resolveMetadata = resolve;
    else resolveCost = resolve;
  });
  const onSnapshot = (snapshot) => snapshots.push(snapshot);
  try {
    await React.act(async () => {
      root.render(React.createElement(MetadataCostProbe, { onSnapshot }));
      await tick();
    });
    assert.equal(typeof resolveMetadata, "function");
    assert.equal(typeof resolveCost, "function");
    assert.equal(snapshots.at(-1).costState, "loading");
    assert.equal(snapshots.at(-1).metadata, null);

    resolveMetadata({ ok: true, json: async () => ({
      stats: { totalMessages: 2, totalTokens: 220, cost: 0, costStatus: "unavailable", statsSource: "reader-file", statsScope: "Reader persisted session file; excludes child sessions and Reader-priced total" },
      contextUsage: { tokens: 110, contextWindow: 128000, percent: 0.08 },
    }) });
    await React.act(async () => { await tick(); await tick(); });
    const metadataFirst = snapshots.at(-1);
    assert.equal(metadataFirst.costState, "loading");
    assert.equal(metadataFirst.metadata.stats.statsSource, "reader-file");
    assert.match(metadataFirst.metadata.stats.statsScope, /excludes child sessions/);
    assert.equal(metadataFirst.metadata.stats.totalTokens, 220);
    assert.equal(metadataFirst.metadata.stats.cost, 0);

    resolveCost({ ok: true, status: 200, json: async () => ({
      amount: 2,
      status: "calculated",
      usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 110 },
      totalCost: { amount: 2, currency: "USD", status: "calculated", usage: null, sessionCount: 2, models: ["openai/gpt-5.5"], missingPriceModels: [], pendingUsageCount: 0, pendingUsageModels: [], unavailableSessions: 0 },
      childCost: { amount: 1, currency: "USD", status: "calculated", usage: null, sessionCount: 1, models: ["openai/gpt-5.5"], missingPriceModels: [], pendingUsageCount: 0, pendingUsageModels: [], unavailableSessions: 0 },
      compactionCost: { amount: 0.2, currency: "USD", status: "calculated", usage: null, sessionCount: 1, models: ["openai/gpt-5.5"], missingPriceModels: [], pendingUsageCount: 0, pendingUsageModels: [], unavailableSessions: 0 },
      recapCost: { amount: 0.1, currency: "USD", status: "calculated", usage: null, sessionCount: 1, models: ["openai/gpt-5.5"], missingPriceModels: [], pendingUsageCount: 0, pendingUsageModels: [], unavailableSessions: 0 },
    }) });
    await React.act(async () => { await tick(); await tick(); });
    const completed = snapshots.at(-1);
    assert.equal(completed.costState, "ready");
    assert.equal(completed.cost.amount, 2);
    assert.equal(completed.cost.childCost.amount, 1);
    assert.equal(completed.cost.compactionCost.amount, 0.2);
    assert.equal(completed.cost.recapCost.amount, 0.1);
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    details.clearSessionDetailsCache();
    globalThis.fetch = originalFetch;
    restoreReactDomShim(previous);
  }
});

test("delayed cost responses cannot cross session, device, branch, or recovery boundaries", async () => {
  const previous = installReactDomShim();
  const originalFetch = globalThis.fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots = [];
  const pending = new Map();
  globalThis.fetch = (url) => new Promise((resolve, reject) => {
    pending.set(String(url), { resolve, reject });
  });
  const onSnapshot = (snapshot) => snapshots.push(snapshot);
  const response = (amount, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => ({ amount, status: ok ? "calculated" : "unavailable" }) });
  try {
    await React.act(async () => {
      root.render(React.createElement(Probe, { sessionId: "old", version: "branch-a", peer: "debian", deviceId: "device-a", loadCost: true, onSnapshot }));
      await tick();
    });
    await React.act(async () => {
      root.render(React.createElement(Probe, { sessionId: "current", version: "branch-b", peer: "air", deviceId: "device-b", loadCost: true, onSnapshot }));
      await tick();
    });
    const oldUrl = [...pending.keys()].find((url) => url.includes("old"));
    const currentUrl = [...pending.keys()].find((url) => url.includes("current"));
    assert.ok(oldUrl && currentUrl);
    pending.get(oldUrl).resolve(response(1));
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(snapshots.at(-1).sessionId, "current");
    assert.notEqual(snapshots.at(-1).amount, 1);
    pending.get(currentUrl).resolve(response(2));
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(snapshots.at(-1).sessionId, "current");
    assert.equal(snapshots.at(-1).amount, 2);
    assert.equal(snapshots.at(-1).peer, "air");
    assert.equal(snapshots.at(-1).deviceId, "device-b");

    details.clearSessionDetailsCache();
    snapshots.length = 0;
    pending.clear();
    await React.act(async () => {
      root.render(React.createElement(Probe, { sessionId: "recover", version: "branch-c", loadCost: true, onSnapshot }));
      await tick();
    });
    const recoverUrl = [...pending.keys()][0];
    pending.get(recoverUrl).resolve(response(null, false));
    pending.delete(recoverUrl);
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(snapshots.at(-1).costState, "error");
    await React.act(async () => {
      root.render(React.createElement(Probe, { sessionId: "recover", version: "branch-c", loadCost: false, onSnapshot }));
      await tick();
    });
    await React.act(async () => {
      root.render(React.createElement(Probe, { sessionId: "recover", version: "branch-c", loadCost: true, onSnapshot }));
      await tick();
    });
    const retryUrl = [...pending.keys()][0];
    assert.equal(retryUrl, recoverUrl, "recovery re-requests the current revision");
    pending.get(retryUrl).resolve(response(3));
    await React.act(async () => { await tick(); await tick(); });
    assert.equal(snapshots.at(-1).costState, "ready");
    assert.equal(snapshots.at(-1).amount, 3);
  } finally {
    await React.act(async () => { root.unmount(); await tick(); });
    details.clearSessionDetailsCache();
    globalThis.fetch = originalFetch;
    restoreReactDomShim(previous);
  }
});
