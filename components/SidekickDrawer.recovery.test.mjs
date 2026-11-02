import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { loadSidekickHelpers } from "../test-support/sidekick-client-fixture.mjs";
import { testTranslator } from "./test-locale.mjs";

const source = readFileSync(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
const key = "current-view";
const t = testTranslator("en");
function recovery({ question = "", images = [], processing = 0, originalQuestion = "original", unconfirmed = false } = {}) {
  const state = { drafts: { [key]: { question, images, error: null } }, replies: {
    [key]: { runId: "original-run", question: originalQuestion, images: ["original-image"], running: false, unconfirmed },
  }, restored: 0, reloaded: 0 };
  const setter = (name) => (value) => { state[name] = typeof value === "function" ? value(state[name]) : value; };
  const context = { viewKey: key, reply: state.replies[key], question, attachedImages: images, isProcessingImages: processing > 0,
    activeThreadId: "a", activeBranchId: "main", sideAskBranchId: "main", AbortController, t,
    streamRequestsRef: { current: new Map([[key, { controller: new AbortController(), runId: "original-run", running: false, retained: true }]]) },
    streamingQuestion: originalQuestion, streamingImages: ["original-image"],
    draftsRef: { get current() { return state.drafts; } }, pendingImageCountRef: { current: new Map([[key, { count: processing }]]) },
    sessionIdentityRef: { current: { sessionId: "session", quickAskUrl: "/quick-ask" } },
    setDrafts: setter("drafts"), setReplies: setter("replies"),
    setViewState: (update) => { const next = update({ drafts: state.drafts, replies: state.replies }); state.drafts = next.drafts; state.replies = next.replies; },
    setQuestion: (value) => { state.drafts[key].question = value; },
    setAttachedImages: (value) => { state.drafts[key].images = value; },
    setAttachmentError: (value) => { state.drafts[key].error = value; },
    restoreQuestionView: () => { state.restored++; },
    historyController: { invalidate() {} }, loadHistory: async () => { state.reloaded++; },
  };
  loadSidekickHelpers(source, context);
  // Exercise the actual restore event handler, including the inline form present in the regression baseline.
  const start = source.indexOf("  const handleRestoreQuestion =");
  const body = start >= 0
    ? `${source.slice(start, source.indexOf("  const handleCopy", start))}\nhandleRestoreQuestion`
    : `() => { ${source.split("\n").find((line) => line.includes(">恢复提问到输入框</button>"))?.match(/onClick=\{\(\) => \{ (.*?) \}\} style=/)?.[1]} }`;
  const restore = vm.runInNewContext(stripTypeScriptTypes(body), context);
  return { state, restore };
}

test("restore keeps a new text/image draft and an in-progress image, without discarding the source reply", () => {
  for (const draft of [{ question: "new text" }, { images: ["new-image"] }, { processing: 1 }]) {
    const f = recovery(draft), before = structuredClone(f.state.drafts[key]);
    f.restore();
    assert.equal(f.state.drafts[key].question, before.question);
    assert.deepEqual(f.state.drafts[key].images, before.images);
    assert.equal(f.state.replies[key].runId, "original-run");
    assert.equal(f.state.restored, 0);
    assert.equal(f.state.drafts[key].error, t("sidekick.restoreDraftBusy"));
  }
});

test("an empty draft restores text and images together, then releases its source reply", () => {
  for (const originalQuestion of ["original", ""]) {
    const f = recovery({ originalQuestion }); f.restore();
    assert.equal(f.state.drafts[key].question, originalQuestion);
    assert.deepEqual(f.state.drafts[key].images, ["original-image"]);
    assert.equal(f.state.replies[key], undefined);
    assert.equal(f.state.restored, 1);
  }
});

test("image-only questions expose the same restore action", () => {
  assert.match(source, /!isStreaming && \(streamingQuestion \|\| streamingImages.length > 0\)/);
});

test("the drawer uses requested model intent while retaining explicit user choice and flat-history fallback", () => {
  const start = source.indexOf("  const storedModel =");
  const declarations = source.slice(start, source.indexOf("  const activeModel =", start));
  const entry = { data: { threadId: "a", branchId: "main", provider: "actual", model: "wire" },
    requestedModel: { provider: "alias", modelId: "intent" } };
  const choose = (items, selectedModel = null) => vm.runInNewContext(`${declarations}\nrequestedModel`, {
    items, selectedModel, defaultModel: { provider: "default", modelId: "main" }, activeThreadId: "a", activeBranchId: "main", sideAskBranchId: "main",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(choose([entry]))), entry.requestedModel);
  const selected = { provider: "manual", modelId: "chosen" };
  assert.deepEqual(choose([entry], selected), selected);
  const flat = { data: entry.data };
  assert.deepEqual(JSON.parse(JSON.stringify(choose([flat]))), { provider: "actual", modelId: "wire" });
});

test("an authoritative deletion clears only its matching reply/request and reloads durable history", () => {
  const initial = { id: "deleted-run", branchId: "main", threadId: "a", status: "running", question: "old", images: [] };
  const identity = { sessionId: "session", quickAskUrl: "/quick-ask" };
  const state = { replies: {}, items: [], threadLists: {}, reloaded: 0 };
  const streamRequestsRef = { current: new Map() }, observeRunRef = { current: null };
  let callbacks;
  const setter = (name) => (value) => { state[name] = typeof value === "function" ? value(state[name]) : value; };
  const start = source.indexOf("  observeRunRef.current = (initial) =>");
  const sharedContext = {
    sessionIdentityRef: { current: identity }, streamRequestsRef, observeRunRef, AbortController, t,
    sidekickViewKey: (url, branch, thread) => JSON.stringify([url, branch, thread]), imageDataUrl: () => "image",
    setReplies: setter("replies"), setItems: setter("items"), setThreadLists: setter("threadLists"), setDrafts() {},
    historyController: { invalidate() {}, load: async () => { state.reloaded++; } },
    observeQuickAskRun: (options) => { callbacks = options; options.onRun(options.run); },
  };
  loadSidekickHelpers(source, sharedContext);
  vm.runInNewContext(stripTypeScriptTypes(source.slice(start, source.indexOf("  const handleSend = async", start))), sharedContext);
  observeRunRef.current(initial);
  const view = JSON.stringify([identity.quickAskUrl, "main", "a"]);
  assert.equal(state.replies[view].running, true);
  assert.equal(typeof callbacks.onDeleted, "function");
  callbacks.onDeleted();
  assert.equal(state.replies[view], undefined);
  assert.equal(streamRequestsRef.current.has(view), false);
  assert.equal(state.reloaded, 1);
  const next = { controller: new AbortController(), runId: "new-run", running: true };
  streamRequestsRef.current.set(view, next);
  state.replies[view] = { runId: "new-run", running: true };
  callbacks.onDeleted();
  assert.equal(streamRequestsRef.current.get(view), next);
  assert.equal(state.replies[view].running, true);
});
