import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import * as observers from "../lib/quick-ask-observer.ts";
import { loadSidekickHelpers } from "../test-support/sidekick-client-fixture.mjs";
import { testTranslator } from "./test-locale.mjs";

const source = readFileSync(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
const image = { data: "AAAA", mimeType: "image/png", previewUrl: "image" };
const scope = { threadId: "a", branchId: "main" };
const deleted = { code: "quick_ask_deleted", runId: "R", ...scope };
function harness({ status = 200, result, lookup, latest = false } = {}) {
  const identity = { sessionId: "session", quickAskUrl: "/quick-ask?peer=device" };
  const viewKey = JSON.stringify([identity.quickAskUrl, "main", "a"]);
  const failed = { id: "R", ...scope, question: "original", images: [image], answer: "", thinking: "", status: "failed", error: "provider failed", revision: 1, createdAt: 1 };
  const newer = { ...failed, id: "R2", question: "other client", status: "completed", error: undefined,
    entry: { id: "E2", data: { ...scope, question: "other client", answer: "new answer" } } };
  const state = { drafts: {}, replies: { [viewKey]: { runId: "R", question: "original", images: [image], answer: "unknown", thinking: "", running: false, unconfirmed: true } },
    items: [], threadLists: {}, reloaded: 0, requests: [] };
  const controller = new AbortController(), streamRequestsRef = { current: new Map([[viewKey, {
    controller, runId: "R", running: false, accepted: false, retained: true,
  }]]) }, observeRunRef = { current: null }, sessionIdentityRef = { current: identity };
  const setter = (name) => (update) => { state[name] = typeof update === "function" ? update(state[name]) : update; };
  const reload = async () => {
    state.reloaded++;
    if (latest) { state.items = [newer.entry]; observeRunRef.current(newer); }
  };
  const context = { viewKey, reply: state.replies[viewKey], sessionIdentityRef, streamRequestsRef, observeRunRef,
    activeThreadId: "a", activeBranchId: "main", sideAskBranchId: "main", quickAskUrl: identity.quickAskUrl,
    question: "", attachedImages: [], isProcessingImages: false,
    draftsRef: { get current() { return state.drafts; } }, pendingImageCountRef: { current: new Map() },
    AbortController, URL, window: { location: { href: "http://reader.test" } }, t: testTranslator("en"),
    readQuickAskRun: observers.readQuickAskRun,
    sidekickViewKey: (url, branch, thread) => JSON.stringify([url, branch, thread]), imageDataUrl: () => "image",
    setViewState: (update) => { const next = update({ drafts: state.drafts, replies: state.replies }); state.drafts = next.drafts; state.replies = next.replies; },
    setReplies: setter("replies"), setDrafts: setter("drafts"), setItems: setter("items"), setThreadLists: setter("threadLists"),
    setAttachmentError: (error) => { state.drafts[viewKey] = { ...(state.drafts[viewKey] ?? { question: "", images: [] }), error }; },
    restoreQuestionView() {}, historyController: { invalidate() {}, load: reload }, loadHistory: reload,
    observeQuickAskRun: (options) => { options.onRun(options.run); },
    fetch: async (url, options = {}) => {
      assert.equal(options.method ?? "GET", "GET", "recovery must never resubmit inference");
      state.requests.push({ url, options });
      return lookup ? lookup(url, options) : Response.json(result ?? { run: failed }, { status });
    },
  };
  loadSidekickHelpers(source, context);
  const observeStart = source.indexOf("  observeRunRef.current = (initial) =>");
  vm.runInNewContext(stripTypeScriptTypes(source.slice(observeStart, source.indexOf("  const handleSend = async", observeStart))), context);
  const restoreStart = source.indexOf("  const handleRestoreQuestion =");
  const restore = vm.runInNewContext(stripTypeScriptTypes(source.slice(restoreStart, source.indexOf("  const handleCopy", restoreStart))) + "\nhandleRestoreQuestion", context);
  return { state, restore, reload, viewKey, streamRequestsRef, controller };
}

test("unknown R is recovered by its exact identity even when the topic history already contains R2", async () => {
  const f = harness({ latest: true });
  try {
    await f.reload();
    assert.equal(f.state.items[0].id, "E2");
    assert.equal(f.state.replies[f.viewKey]?.question, "original", "latest history must not erase the retained unknown source");
    await f.restore();
    assert.equal(f.state.requests.length, 1);
    const url = new URL(f.state.requests[0].url, "http://reader.test");
    assert.equal(url.searchParams.get("runId"), "R");
    assert.equal(url.searchParams.get("peer"), "device");
    assert.equal(url.searchParams.has("stream"), false);
    assert.equal(f.state.replies[f.viewKey].runId, "R");
    assert.equal(f.state.replies[f.viewKey].question, "original");
    assert.deepEqual(f.state.replies[f.viewKey].images, [image]);
    assert.equal(f.state.replies[f.viewKey].unconfirmed ?? false, false);
    assert.match(f.state.replies[f.viewKey].answer, /provider failed/);
    await f.reload();
    assert.equal(f.state.replies[f.viewKey].runId, "R", "even a late history refresh must retain the recovered source until acknowledged");
  } finally { f.controller.abort(); }
});

test("manual unknown recovery consumes matching deletion evidence and then synchronizes history", async () => {
  const f = harness({ status: 410, result: deleted });
  await f.restore();
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.replies[f.viewKey], undefined);
  assert.equal(f.streamRequestsRef.current.has(f.viewKey), false);
  assert.equal(f.state.reloaded, 1);
});

test("a late identity result cannot remove a replacement run", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = harness({ lookup: () => gate });
  const recovering = f.restore();
  try {
    assert.equal(f.state.requests.length, 1);
    const replacement = { controller: new AbortController(), runId: "R2", running: true };
    f.streamRequestsRef.current.set(f.viewKey, replacement);
    f.state.replies[f.viewKey] = { runId: "R2", question: "new", images: [], running: true };
    release(Response.json(deleted, { status: 410 })); await recovering;
    assert.equal(f.streamRequestsRef.current.get(f.viewKey), replacement);
    assert.equal(f.state.replies[f.viewKey].runId, "R2");
    assert.equal(replacement.controller.signal.aborted, false);
    assert.equal(f.state.reloaded, 0);
  } finally { release(Response.json(deleted, { status: 410 })); f.controller.abort(); await recovering; }
});
