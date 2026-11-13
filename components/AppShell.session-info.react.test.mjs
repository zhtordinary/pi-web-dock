import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionInfoResourcePanel } = await jiti.import("./SessionInfoResourcePanel.tsx");
const { SessionTopBarStats } = await jiti.import("./SessionTopBarStats.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
const { useSessionDetails } = await jiti.import("../hooks/useSessionDetails.ts");
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
  get textContent() {
    return this.childNodes.map((child) => child.nodeType === 3 ? String(child.nodeValue ?? "") : String(child.textContent ?? "")).join("");
  }
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

class ReactDomCommentShim {
  constructor(ownerDocument, value) {
    this.ownerDocument = ownerDocument;
    this.nodeType = 8;
    this.nodeValue = value;
    this.parentNode = null;
  }
  get textContent() { return ""; }
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
  createComment(value) { return new ReactDomCommentShim(this, value); }
  addEventListener() {}
  removeEventListener() {}
  getElementById() { return null; }
}

class ReactDomIFrameShim extends ReactDomNodeShim {}

class ControlledEventSource {
  static instances = new Set();
  static created = 0;
  static closed = 0;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url) {
    this.url = String(url);
    this.readyState = ControlledEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    ControlledEventSource.instances.add(this);
    ControlledEventSource.created += 1;
    Promise.resolve().then(() => {
      if (this.closed) return;
      this.readyState = ControlledEventSource.OPEN;
      this.onopen?.({ type: "open", target: this });
      this.onmessage?.({
        data: JSON.stringify({
          type: "connected",
          sessionId: this.url,
          runtimeAvailable: false,
          pendingExtensionUiIds: [],
        }),
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = ControlledEventSource.CLOSED;
    ControlledEventSource.instances.delete(this);
    ControlledEventSource.closed += 1;
  }
}

function installReactDomShim() {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    actEnvironment: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    intersectionObserver: Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver"),
    resizeObserver: Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"),
    eventSource: Object.getOwnPropertyDescriptor(globalThis, "EventSource"),
  };
  globalThis.window = {};
  globalThis.window.HTMLIFrameElement = ReactDomIFrameShim;
  globalThis.window.HTMLElement = ReactDomNodeShim;
  globalThis.window.Node = ReactDomNodeShim;
  globalThis.window.Document = ReactDomDocumentShim;
  globalThis.window.location = { protocol: "http:" };
  globalThis.window.setInterval = globalThis.setInterval;
  globalThis.window.clearInterval = globalThis.clearInterval;
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  globalThis.window.requestAnimationFrame = (callback) => setImmediate(callback);
  globalThis.window.cancelAnimationFrame = (id) => clearImmediate(id);
  globalThis.window.IntersectionObserver = class { observe() {} disconnect() {} };
  globalThis.window.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.window.EventSource = ControlledEventSource;
  globalThis.IntersectionObserver = globalThis.window.IntersectionObserver;
  globalThis.ResizeObserver = globalThis.window.ResizeObserver;
  globalThis.EventSource = ControlledEventSource;
  globalThis.document = new ReactDomDocumentShim();
  globalThis.document.visibilityState = "visible";
  globalThis.window.document = globalThis.document;
  globalThis.window.window = globalThis.window;
  globalThis.window.self = globalThis.window;
  globalThis.window.top = globalThis.window;
  globalThis.window.parent = globalThis.window;
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node" },
    configurable: true,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return previous;
}

function restoreReactDomShim(previous) {
  const openEventSources = ControlledEventSource.instances.size;
  const restore = (name, descriptor) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
  try {
    restore("window", previous.window);
    restore("document", previous.document);
    restore("IS_REACT_ACT_ENVIRONMENT", previous.actEnvironment);
    restore("navigator", previous.navigator);
    restore("IntersectionObserver", previous.intersectionObserver);
    restore("ResizeObserver", previous.resizeObserver);
    restore("EventSource", previous.eventSource);
  } finally {
    if (openEventSources !== 0) throw new Error(`controlled EventSource leak: ${openEventSources}`);
  }
}

const SESSION_ID = "synthetic-session";
const SCOPE = "Official files only; excludes child sessions and Reader mainCost";
const ZERO_COST = /\$0(?:\.0+)?(?![\d.])/;

test("zero-cost marker does not match positive sub-dollar amounts", () => {
  for (const value of ["$0", "$0.0000"]) assert.match(value, ZERO_COST);
  for (const value of ["$0.0500", "$0.7500"]) assert.doesNotMatch(value, ZERO_COST);
});

function usage({ inputTokens, cachedInputTokens = 0, cacheWriteTokens = 0, outputTokens, totalTokens }) {
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens,
  };
}

function costSummary(amount, sessionCount = 1, tokens = usage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })) {
  return {
    amount,
    currency: "USD",
    status: "calculated",
    usage: tokens,
    sessionCount,
    models: ["fixture/model"],
    missingPriceModels: [],
    pendingUsageCount: 0,
    pendingUsageModels: [],
    unavailableSessions: 0,
  };
}

const metadataBody = {
  sessionId: SESSION_ID,
  stats: {
    sessionId: SESSION_ID,
    userMessages: 3,
    assistantMessages: 2,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 6,
    tokens: { input: 220, output: 44, cacheRead: 11, cacheWrite: 5, total: 280 },
    cost: 0,
    costStatus: "unavailable",
    costState: "loading",
    statsSource: "reader-file",
    statsScope: SCOPE,
    extensionUsages: [{ key: "fixture-extension", label: "Fixture extension" }],
  },
  contextUsage: { tokens: 180, contextWindow: 1000, percent: 18 },
  timing: {
    effectiveMs: 1000,
    agentTotalMs: 1200,
    modelResponseMs: 800,
    modelResponsePercent: 66.7,
    toolMs: 100,
    otherMs: 100,
    retryWaitMs: 0,
    userWaitMs: 0,
    parent: { agentTotalMs: 1200, modelResponseMs: 800 },
    children: { count: 1, agentTotalMs: 200, modelResponseMs: 150, missingRecords: 0 },
    turns: [],
    quality: "complete",
    scope: "session",
  },
};

const pricedCostBody = {
  amount: 2.5,
  currency: "USD",
  status: "calculated",
  usage: usage({ inputTokens: 100, cachedInputTokens: 10, cacheWriteTokens: 5, outputTokens: 20, totalTokens: 135 }),
  parentCost: costSummary(1.5, 1, usage({ inputTokens: 75, outputTokens: 15, totalTokens: 90 })),
  childCost: costSummary(0.75, 2, usage({ inputTokens: 25, outputTokens: 5, totalTokens: 30 })),
  mainCost: costSummary(2.25, 4, usage({ inputTokens: 100, cachedInputTokens: 10, cacheWriteTokens: 5, outputTokens: 20, totalTokens: 135 })),
  compactionCost: costSummary(0.1, 1, usage({ inputTokens: 8, outputTokens: 2, totalTokens: 10 })),
  recapCost: costSummary(0.15, 1, usage({ inputTokens: 7, outputTokens: 1, totalTokens: 8 })),
  totalCost: costSummary(2.5, 4, usage({ inputTokens: 115, cachedInputTokens: 10, cacheWriteTokens: 5, outputTokens: 23, totalTokens: 153 })),
  messageCosts: {},
  imageGenerationCosts: [],
  missingPriceModels: [],
  pendingUsageCount: 0,
  pendingUsageModels: [],
  compactionCosts: {},
  compactionContexts: {},
  contextUsage: { tokens: 500, contextWindow: 2000, percent: 25 },
  extensionCosts: [{
    id: "fixture-extension",
    amount: 0.05,
    currency: "USD",
    status: "calculated",
    usage: usage({ inputTokens: 3, outputTokens: 1, totalTokens: 4 }),
    sessionCount: 1,
    models: ["fixture/model"],
    missingPriceModels: [],
    pendingUsageCount: 0,
    pendingUsageModels: [],
    unavailableSessions: 0,
    historicalIncomplete: false,
    historicalEstimated: false,
  }],
};

const partialCostBody = {
  ...pricedCostBody,
  amount: 1.25,
  status: "partial",
  missingPriceModels: ["fixture/unpriced"],
  pendingUsageCount: 1,
  pendingUsageModels: ["fixture/unpriced"],
  totalCost: { ...pricedCostBody.totalCost, amount: 1.25, status: "partial", missingPriceModels: ["fixture/unpriced"], pendingUsageCount: 1, pendingUsageModels: ["fixture/unpriced"] },
};

const fixtureSession = {
  id: SESSION_ID,
  path: "/tmp/synthetic-session.jsonl",
  cwd: "/tmp/synthetic-project",
  created: "2026-01-01T00:00:00.000Z",
  modified: "synthetic-v1",
  messageCount: 6,
  firstMessage: "synthetic session",
  transient: false,
};

const metadataResponseBody = {
  ...metadataBody,
  filePath: fixtureSession.path,
  leafId: null,
  tree: [],
  context: { messages: [], entryIds: [], thinkingLevel: "off", model: null },
  metadataOnly: true,
};

function metadataForSession(sessionId, inputTokens = 220, contextTokens = 180, contextWindow = 1000) {
  return {
    ...metadataResponseBody,
    sessionId,
    stats: {
      ...metadataResponseBody.stats,
      sessionId,
      tokens: { ...metadataResponseBody.stats.tokens, input: inputTokens, total: inputTokens + 44 + 11 + 5 },
    },
    contextUsage: { tokens: contextTokens, contextWindow, percent: contextWindow > 0 ? (contextTokens / contextWindow) * 100 : null },
  };
}

function ProductionSessionInfoView({ sessionId = SESSION_ID, onTiming, liveContextUsage = null }) {
  const session = React.useMemo(() => ({ ...fixtureSession, id: sessionId, modified: `${sessionId}-v1` }), [sessionId]);
  const agent = useAgentSession({
    session,
    sessionRunning: false,
    newSessionCwd: null,
    newSessionDraftKey: null,
  });
  const topBarDetails = useSessionDetails({ sessionId, version: session.modified, loadCost: true });
  const sessionStats = agent.sessionStats;
  const contextUsage = liveContextUsage ?? topBarDetails.cost?.contextUsage ?? sessionStats?.contextUsage ?? null;
  const reported = React.useRef({ metadata: false, cost: false });
  React.useEffect(() => {
    if (!agent.loading && agent.data?.metadataOnly && !reported.current.metadata) {
      reported.current.metadata = true;
      onTiming("metadata", performance.now());
    }
  }, [agent.data?.metadataOnly, agent.loading, onTiming]);
  React.useEffect(() => {
    if (sessionStats?.costState === "ready" && sessionStats.statsSource === "reader-cost" && !reported.current.cost) {
      reported.current.cost = true;
      onTiming("cost", performance.now());
    }
  }, [onTiming, sessionStats?.costState, sessionStats?.statsSource]);
  return React.createElement(React.Fragment, null,
    React.createElement(SessionTopBarStats, {
      sessionActive: true,
      sessionStats,
      contextUsage,
      active: false,
      onOpen() {},
    }),
    sessionStats && React.createElement(SessionInfoResourcePanel, {
      sessionStats,
      contextUsage,
      expandedCostModels: { plugin: true },
      toggleCostModels() {},
    }),
  );
}

function RealSessionInfoHarness({ sessionId = SESSION_ID, onTiming, liveContextUsage = null }) {
  return React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(ProductionSessionInfoView, { key: sessionId, sessionId, onTiming, liveContextUsage }));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function installControlledFetch() {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (input, options) => {
    const url = String(input);
    if (url.includes("metadataOnly=1") || url.endsWith("/cost")) {
      return new Promise((resolve, reject) => {
        requests.push({ url, options, resolve, reject, settled: false });
      });
    }
    const body = url.includes("/models")
      ? { models: [] }
      : url.includes("/state") || url.includes("/agent/")
        ? { running: false, code: "session_state_unavailable" }
        : {};
    const result = Promise.resolve(response(body));
    requests.push({ url, options, settled: true, auto: true });
    return result;
  };
  return {
    requests,
    restore() { globalThis.fetch = previousFetch; },
  };
}

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function findNodes(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  for (const child of node.childNodes ?? []) findNodes(child, predicate, result);
  return result;
}

async function resolvePendingRequests(controlled, predicate, body) {
  let resolved = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pending = controlled.requests.filter((request) => !request.settled && predicate(request));
    if (pending.length === 0) break;
    for (const request of pending) {
      request.resolve(response(body));
      request.settled = true;
      resolved += 1;
    }
    await tick();
  }
  assert.ok(resolved > 0, "expected at least one controlled request");
  return resolved;
}

test("production session-info UI follows metadata and cost requests from loading to Reader-priced ready", async () => {
  const previous = installReactDomShim();
  const controlled = installControlledFetch();
  details.clearSessionDetailsCache();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const eventSourcesBefore = ControlledEventSource.created;
  const timings = {};
  const startedAt = performance.now();
  const onTiming = (kind, timestamp) => { timings[kind] = timestamp - startedAt; };
  try {
    await React.act(async () => {
      root.render(React.createElement(RealSessionInfoHarness, { onTiming }));
      await tick();
    });
    const metadataRequest = controlled.requests.find((request) => request.url.includes("metadataOnly=1"));
    const costRequest = controlled.requests.find((request) => request.url.endsWith("/cost"));
    assert.ok(metadataRequest, "production metadata fetch must be issued");
    assert.ok(costRequest, "useSessionDetails must issue the production cost fetch");
    assert.ok(ControlledEventSource.created > eventSourcesBefore, "production mount must create a controlled EventSource");
    assert.equal(costRequest.settled, false);
    assert.equal(container.textContent, "");

    await React.act(async () => {
      await resolvePendingRequests(controlled, (request) => request.url.includes("metadataOnly=1"), metadataResponseBody);
      await tick();
    });
    const beforePricing = container.textContent;
    assert.equal(typeof timings.metadata, "number");
    assert.equal(typeof timings.cost, "undefined", "cost must remain pending after metadata is ready");
    const topStatusBefore = findNodes(container, (node) => node.attributes?.["aria-label"] === "Session info");
    assert.equal(topStatusBefore.length, 1);
    assert.match(topStatusBefore[0].textContent, /18% \/ 1k/);
    assert.match(topStatusBefore[0].textContent, /…/);
    assert.match(beforePricing, /Tokens/);
    assert.match(beforePricing, /Input/);
    assert.match(beforePricing, /220/);
    assert.match(beforePricing, /Context/);
    assert.match(beforePricing, /18\.0%/);
    assert.match(beforePricing, new RegExp(SCOPE));
    assert.match(beforePricing, /Loading\.\.\./);
    assert.doesNotMatch(beforePricing, ZERO_COST);
    assert.equal(costRequest.settled, false);

    await React.act(async () => {
      costRequest.resolve(response(pricedCostBody));
      costRequest.settled = true;
      await tick();
      await tick();
    });
    const afterPricing = container.textContent;
    assert.equal(typeof timings.cost, "number");
    assert.ok(timings.cost >= timings.metadata, "cost ready must follow metadata ready");
    const topStatusAfter = findNodes(container, (node) => node.attributes?.["aria-label"] === "Session info");
    assert.equal(topStatusAfter.length, 1);
    assert.match(topStatusAfter[0].textContent, /25% \/ 2k/);
    assert.match(topStatusAfter[0].textContent, /\$2\.50/);
    assert.match(afterPricing, /100/);
    assert.match(afterPricing, /25\.0%/);
    assert.match(afterPricing, /\$2\.5000/);
    assert.match(afterPricing, /2 subagent costs/);
    assert.match(afterPricing, /Compaction cost/);
    assert.match(afterPricing, /Recap cost/);
    assert.match(afterPricing, /fixture-extension cost/);
    assert.match(afterPricing, /Effective total duration/);
    assert.doesNotMatch(afterPricing, /220/);
    assert.doesNotMatch(afterPricing, /Official files only/);
    assert.doesNotMatch(afterPricing, /Unpriced/);

    await React.act(async () => {
      root.render(React.createElement(RealSessionInfoHarness, {
        sessionId: SESSION_ID,
        onTiming,
        liveContextUsage: { tokens: 840, contextWindow: 2000, percent: 42 },
      }));
      await tick();
    });
    const liveContextStatus = findNodes(container, (node) => node.attributes?.["aria-label"] === "Session info");
    assert.equal(liveContextStatus.length, 1);
    assert.match(liveContextStatus[0].textContent, /42% \/ 2k/);
    assert.doesNotMatch(liveContextStatus[0].textContent, /25% \/ 2k/);

    console.log(JSON.stringify({
      metadataReadyMs: Number(timings.metadata.toFixed(3)),
      costReadyMs: Number(timings.cost.toFixed(3)),
      relativeCostAfterMetadataMs: Number((timings.cost - timings.metadata).toFixed(3)),
      requestUrls: controlled.requests.map((request) => request.url),
      lightweightTokens: 220,
      readerTokens: 100,
      readerTotalCost: 2.5,
      readerChildSessions: 2,
      scope: SCOPE,
    }));
  } finally {
    await React.act(async () => {
      root.unmount();
      await tick();
    });
    details.clearSessionDetailsCache();
    controlled.restore();
    restoreReactDomShim(previous);
  }
});

test("production session-info UI keeps partial, cached, and unknown cost states visible", async () => {
  const previous = installReactDomShim();
  const controlled = installControlledFetch();
  details.clearSessionDetailsCache();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(RealSessionInfoHarness, { sessionId: "synthetic-partial-session", onTiming() {} }));
      await tick();
    });
    const metadataRequest = controlled.requests.find((request) => request.url.includes("metadataOnly=1"));
    const costRequest = controlled.requests.find((request) => request.url.endsWith("/cost"));
    assert.ok(metadataRequest);
    assert.ok(costRequest);
    await React.act(async () => {
      await resolvePendingRequests(controlled, (request) => request.url.includes("metadataOnly=1"), metadataForSession("synthetic-partial-session"));
      await tick();
    });
    await React.act(async () => {
      costRequest.resolve(response(partialCostBody));
      costRequest.settled = true;
      await tick();
      await tick();
    });
    const topStatus = findNodes(container, (node) => node.attributes?.["aria-label"] === "Session info");
    assert.equal(topStatus.length, 1);
    assert.match(topStatus[0].textContent, /CH 8\.7%/);
    assert.match(topStatus[0].textContent, /≥\$1\.25/);
    assert.match(container.textContent, /≥\$1\.2500/);
    assert.match(container.textContent, /fixture\/unpriced/);
    assert.doesNotMatch(container.textContent, ZERO_COST);
  } finally {
    await React.act(async () => {
      root.unmount();
      await tick();
    });
    details.clearSessionDetailsCache();
    controlled.restore();
    restoreReactDomShim(previous);
  }
});

test("production session-info UI ignores a stale response after the session identity changes", async () => {
  const previous = installReactDomShim();
  const controlled = installControlledFetch();
  details.clearSessionDetailsCache();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(RealSessionInfoHarness, { sessionId: "identity-a", onTiming() {} }));
      await tick();
    });
    const metadataA = controlled.requests.find((request) => request.url.includes("identity-a") && request.url.includes("metadataOnly=1"));
    const costA = controlled.requests.find((request) => request.url.includes("identity-a") && request.url.endsWith("/cost"));
    assert.ok(metadataA);
    assert.ok(costA);
    await React.act(async () => {
      await resolvePendingRequests(controlled, (request) => request.url.includes("identity-a") && request.url.includes("metadataOnly=1"), metadataForSession("identity-a", 220, 180, 1000));
      await tick();
    });
    assert.match(container.textContent, /220/);

    await React.act(async () => {
      root.render(React.createElement(RealSessionInfoHarness, { sessionId: "identity-b", onTiming() {} }));
      await tick();
    });
    const metadataB = controlled.requests.find((request) => !request.settled && request.url.includes("identity-b") && request.url.includes("metadataOnly=1"));
    const costB = controlled.requests.find((request) => !request.settled && request.url.includes("identity-b") && request.url.endsWith("/cost"));
    assert.ok(metadataB);
    assert.ok(costB);
    await React.act(async () => {
      await resolvePendingRequests(controlled, (request) => request.url.includes("identity-b") && request.url.includes("metadataOnly=1"), metadataForSession("identity-b", 330, 300, 1200));
      await tick();
    });
    assert.match(container.textContent, /330/);
    assert.doesNotMatch(container.textContent, /220/);

    await React.act(async () => {
      costA.resolve(response(pricedCostBody));
      costA.settled = true;
      await tick();
      await tick();
    });
    assert.doesNotMatch(container.textContent, /\$2\.50/);
    assert.match(container.textContent, /330/);

    await React.act(async () => {
      costB.resolve(response({
        ...pricedCostBody,
        amount: 3.5,
        mainCost: { ...pricedCostBody.mainCost, usage: usage({ inputTokens: 300, cachedInputTokens: 30, cacheWriteTokens: 10, outputTokens: 50, totalTokens: 390 }) },
        totalCost: { ...pricedCostBody.totalCost, amount: 3.5, usage: usage({ inputTokens: 330, cachedInputTokens: 30, cacheWriteTokens: 10, outputTokens: 55, totalTokens: 425 }) },
        contextUsage: { tokens: 700, contextWindow: 3000, percent: 23.333 },
      }));
      costB.settled = true;
      await tick();
      await tick();
    });
    assert.match(container.textContent, /300/);
    assert.match(container.textContent, /\$3\.50/);
    assert.doesNotMatch(container.textContent, /\$2\.50/);
  } finally {
    await React.act(async () => {
      root.unmount();
      await tick();
    });
    details.clearSessionDetailsCache();
    controlled.restore();
    restoreReactDomShim(previous);
  }
});

test("production session-info UI marks an actual cost request failure as unavailable instead of free", async () => {
  const previous = installReactDomShim();
  const controlled = installControlledFetch();
  details.clearSessionDetailsCache();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onTiming = () => {};
  try {
    await React.act(async () => {
      root.render(React.createElement(RealSessionInfoHarness, { sessionId: "synthetic-error-session", onTiming }));
      await tick();
    });
    const metadataRequest = controlled.requests.find((request) => request.url.includes("metadataOnly=1"));
    const costRequest = controlled.requests.find((request) => request.url.endsWith("/cost"));
    assert.ok(metadataRequest);
    assert.ok(costRequest);
    await React.act(async () => {
      await resolvePendingRequests(controlled, (request) => request.url.includes("metadataOnly=1"), metadataForSession("synthetic-error-session"));
      await tick();
    });
    await React.act(async () => {
      costRequest.resolve(response({}, false, 503));
      costRequest.settled = true;
      await tick();
      await tick();
    });
    const text = container.textContent;
    assert.match(text, /Unpriced/);
    assert.doesNotMatch(text, ZERO_COST);
  } finally {
    await React.act(async () => {
      root.unmount();
      await tick();
    });
    details.clearSessionDetailsCache();
    controlled.restore();
    restoreReactDomShim(previous);
  }
});
