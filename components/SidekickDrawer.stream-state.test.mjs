import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import * as quickAskObservers from "../lib/quick-ask-observer.ts";
import { loadSidekickHelpers, runSidekickReplyLayout } from "../test-support/sidekick-client-fixture.mjs";
import { testTranslator } from "./test-locale.mjs";
const t = testTranslator("en");
const { observeQuickAskRun } = quickAskObservers;
const source = readFileSync(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
const sendSource = stripTypeScriptTypes(source.slice(source.indexOf("  const handleSend = async"), source.indexOf("  const handleAbort")));
const observeSource = stripTypeScriptTypes(source.slice(source.indexOf("  observeRunRef.current = (initial) =>"), source.indexOf("  const handleSend = async")));
const key = (url, branch, thread) => JSON.stringify([url, branch, thread]);
function harness({ queued = false } = {}) {
  const state = { replies: {}, items: [], drafts: {}, threadLists: {}, identity: { sessionId: "session", quickAskUrl: "/api/session/quick-ask" } };
  const streamRequestsRef = { current: new Map() }, sessionIdentityRef = { current: state.identity }, streams = new Map(), runs = new Map(), requests = [], updates = [];
  const observeRunRef = { current: null }, pendingImageCountRef = { current: new Map() };
  const schedule = (fn) => { if (queued) updates.push(fn); else { fn(); runLayout(); } };
  const setter = (name) => (value) => schedule(() => { state[name] = typeof value === "function" ? value(state[name]) : value; });
  const historyController = { isCurrentIdentity: (id, url) => sessionIdentityRef.current.sessionId === id && sessionIdentityRef.current.quickAskUrl === url, invalidate() {}, async load() {} };
  const shared = { streamRequestsRef, sessionIdentityRef, historyController, observeRunRef, pendingImageCountRef, sidekickViewKey: key,
    readQuickAskRun: quickAskObservers.readQuickAskRun, t,
    setViewState: (update) => schedule(() => {
      const next = update({ drafts: state.drafts, replies: state.replies });
      state.drafts = next.drafts; state.replies = next.replies;
    }),
    setReplies: setter("replies"), setItems: setter("items"), setThreadLists: setter("threadLists"), setDrafts: setter("drafts"),
    AbortController, crypto: { randomUUID }, imageDataUrl: (image) => `data:${image.mimeType};base64,${image.data}`,
    observeQuickAskRun: (options) => observeQuickAskRun({ ...options, eventSource: (url) => {
      const runId = new URL(url, "http://reader.test").searchParams.get("runId");
      const run = [...runs.values()].find((item) => item.id === runId);
      assert.ok(run, "GET observer must target a previously admitted host run");
      const viewKey = key(options.url, run.branchId, run.threadId);
      const stream = { onmessage: null, onerror: null, closed: false, close() { this.closed = true; } };
      streams.set(viewKey, stream);
      return stream;
    } }),
  };
  const runLayout = () => runSidekickReplyLayout(source, { streamRequestsRef, replies: state.replies });
  loadSidekickHelpers(source, shared);
  vm.runInNewContext(observeSource, shared);
  function createSend(thread, { branch = "main", question = `question ${thread}`, images = [], reject, lookup } = {}) {
    const viewKey = key(state.identity.quickAskUrl, branch, thread);
    const context = { ...shared, question, attachedImages: images, viewKey, isForking: false, selectedModel: null, requestedModel: null, selectedThinkingLevel: "auto", isProcessingImages: false, sessionId: state.identity.sessionId, quickAskUrl: state.identity.quickAskUrl, activeBranchId: branch, sideAskBranchId: branch, activeThreadId: thread, activeThreadIndex: thread === "default" ? 0 : 1, activeParentId: undefined,
      setQuestion: (text) => setter("drafts")((previous) => ({ ...previous, [viewKey]: { ...(previous[viewKey] ?? { images: [], error: null }), question: text } })),
      setAttachedImages: (value) => setter("drafts")((previous) => ({ ...previous, [viewKey]: { ...(previous[viewKey] ?? { question: "", error: null }), images: value } })), setAttachmentError() {},
      URL, window: { location: { href: "http://reader.test" } },
      draftsRef: { get current() { return state.drafts; } },
      fetch: async (url, options = {}) => {
        if (!options.body) return lookup ? lookup(url, options) : Response.json({ error: "Unknown request" }, { status: 404 });
        const body = JSON.parse(options.body); requests.push({ url, body });
        assert.equal(body.action, "start", "transport observation must not resubmit or stop inference");
        if (reject) { if (reject.wait) await reject.wait; return Response.json({ error: reject.error }, { status: reject.status }); }
        const run = { id: body.requestId, threadId: body.threadId, branchId: body.branchId,
          question: body.question, images: body.images, status: "running", answer: "", thinking: "", createdAt: 1, revision: 0 };
        runs.set(viewKey, run);
        return Response.json({ run });
      },
    };
    loadSidekickHelpers(source, context);
    return { send: vm.runInNewContext(`${sendSource}\nhandleSend`, context), viewKey };
  }
  const emit = (viewKey, data) => {
    const run = runs.get(viewKey);
    const revision = ++run.revision;
    streams.get(viewKey).onmessage({ data: JSON.stringify({ runId: run.id, revision, ...data }) });
  };
  const finish = (viewKey, id, entryOverrides = {}) => {
    const run = runs.get(viewKey);
    emit(viewKey, { type: "done", run: { ...run, status: "completed", revision: run.revision + 1 },
      entry: { id, data: { threadId: run.threadId, branchId: run.branchId, question: run.question, answer: id, ...entryOverrides } } });
  };
  const flush = () => { while (updates.length) updates.shift()(); runLayout(); };
  const queueDraft = (viewKey, draft) => setter("drafts")((previous) => ({ ...previous, [viewKey]: draft }));
  const queueImage = (viewKey, image) => setter("drafts")((previous) => ({ ...previous, [viewKey]: {
    ...previous[viewKey], images: [...previous[viewKey].images, image].slice(0, 10),
  } }));
  return { state, createSend, emit, finish, requests, streams, runs, streamRequestsRef, sessionIdentityRef, pendingImageCountRef, queueDraft, queueImage, flush };
}

test("two threads stream independently, block only their own duplicate send and persist in original threads", async () => {
  const f = harness(), a = f.createSend("default"), b = f.createSend("second");
  const pa = a.send(), pb = b.send(); await a.send();
  await Promise.all([pa, pb]);
  assert.equal(f.requests.length, 2);
  f.emit(a.viewKey, { type: "chunk", delta: "answer A" });
  f.emit(b.viewKey, { type: "chunk", delta: "answer B" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.replies[a.viewKey].answer, "answer A");
  assert.equal(f.state.replies[b.viewKey].answer, "answer B");
  f.finish(b.viewKey, "B"); await pb;
  assert.equal(f.state.replies[a.viewKey].running, true);
  assert.equal(f.state.replies[b.viewKey], undefined);
  f.finish(a.viewKey, "A"); await pa;
  assert.deepEqual(Array.from(f.state.items, (item) => item.id), ["B", "A"]);
  assert.deepEqual(f.requests.map((request) => request.body.threadId), ["default", "second"]);
});

test("batched React updates still retain the completed durable entry after observer cleanup", async () => {
  const f = harness({ queued: true }), a = f.createSend("second");
  await a.send(); f.finish(a.viewKey, "entry"); f.flush();
  assert.equal(f.state.items.length, 1);
  assert.equal(f.state.replies[a.viewKey], undefined);
  assert.equal(f.streamRequestsRef.current.get(a.viewKey).running, false);
});

test("peer/session changes and deleted threads reject late chunks, completion and observer cleanup", async () => {
  for (const change of ["identity", "delete"]) {
    const f = harness(), old = f.createSend("default"); await old.send();
    if (change === "identity") f.sessionIdentityRef.current = { sessionId: "other", quickAskUrl: "/other" };
    f.streamRequestsRef.current.clear(); f.state.replies = {};
    f.emit(old.viewKey, { type: "chunk", delta: "late" });
    f.finish(old.viewKey, "old");
    assert.deepEqual(f.state.items, []);
    assert.deepEqual(f.state.replies, {});
  }
});

test("a host error stays with the originating thread and preserves retry content", async () => {
  const f = harness(), a = f.createSend("default", { images: [{ data: "image", mimeType: "image/png" }] }), b = f.createSend("second");
  await a.send(); f.state.drafts[b.viewKey] = { question: "new question in B", images: [] };
  f.emit(a.viewKey, { type: "error", run: { ...f.runs.get(a.viewKey), status: "failed", error: "provider failure" } });
  assert.equal(f.state.items.length, 0);
  assert.match(f.state.replies[a.viewKey].answer, /provider failure/);
  assert.equal(f.state.replies[a.viewKey].question, "question default");
  assert.equal(f.state.replies[a.viewKey].images.length, 1);
  assert.equal(f.state.replies[a.viewKey].running, false);
  assert.equal(f.state.drafts[b.viewKey].question, "new question in B");
});

test("a stored host stop reason is shown in the current interface language", async () => {
  const f = harness(), a = f.createSend("default");
  await a.send();
  f.emit(a.viewKey, { type: "error", run: { ...f.runs.get(a.viewKey), status: "failed", error: "已停止" } });
  assert.match(f.state.replies[a.viewKey].answer, /\[Stopped\]/);
  assert.equal(f.state.replies[a.viewKey].running, false);
});

test("a 4xx admission refusal returns the unsent input instead of reporting an unknown state", async () => {
  const f = harness();
  const transferred = f.createSend("default", { images: [{ data: "image", mimeType: "image/png" }], reject: { status: 409, error: "该侧问正在转出或已转为独立会话" } });
  await transferred.send();
  assert.equal(f.state.replies[transferred.viewKey], undefined);
  assert.equal(f.state.drafts[transferred.viewKey].question, "question default");
  assert.equal(f.state.drafts[transferred.viewKey].images.length, 1);
  assert.equal(f.state.drafts[transferred.viewKey].error, t("sidekick.notSent", { reason: t("sidekick.hostTransferInProgress") }));
  assert.equal(f.streamRequestsRef.current.has(transferred.viewKey), false);

  // Input typed while the request was in flight stays; the refused question stays visible as unsent.
  const busy = f.createSend("second", { reject: { status: 409, error: "该话题正在回答，请等待完成或显式停止" } });
  const sending = busy.send();
  f.state.drafts[busy.viewKey] = { question: "typed meanwhile", images: [] };
  await sending;
  assert.equal(f.state.drafts[busy.viewKey].question, "typed meanwhile");
  assert.equal(f.state.replies[busy.viewKey].question, "question second");
  assert.equal(f.state.replies[busy.viewKey].answer, `[${t("sidekick.notSent", { reason: t("sidekick.hostTopicBusy") })}]`);
  assert.equal(f.state.replies[busy.viewKey].running, false);

  // A 5xx may follow an admission, so it keeps the existing unknown-state recovery.
  const uncertain = f.createSend("third", { reject: { status: 500, error: "synthetic persistence failure" } });
  await uncertain.send();
  assert.ok(f.state.replies[uncertain.viewKey].answer.includes(t("sidekick.statusUnconfirmed", { error: "Error: synthetic persistence failure" })));
  assert.equal(f.state.drafts[uncertain.viewKey].question, "");
});

test("a completion with another thread or branch's entry is rejected without losing the originating question or images", async () => {
  for (const mismatch of [{ threadId: "second" }, { branchId: "branch-b" }]) {
    const f = harness(), a = f.createSend("default", { images: [{ data: "image", mimeType: "image/png" }] }), b = f.createSend("second");
    await a.send(); f.state.drafts[b.viewKey] = { question: "new question in B", images: [] };
    f.finish(a.viewKey, "wrong", mismatch);
    assert.equal(f.state.items.length, 0);
    assert.ok(f.state.drafts[a.viewKey].error.includes(t("sidekick.resultOwnershipMismatch")));
    assert.equal(f.state.replies[a.viewKey].question, "question default");
    assert.equal(f.state.replies[a.viewKey].images.length, 1);
    assert.equal(f.state.drafts[b.viewKey].question, "new question in B");
    assert.equal(f.streams.get(a.viewKey).closed, true);
    assert.equal(f.requests.length, 1, "a bad observer cannot retry or stop the host task");
  }
});

test("the same thread name on different branches uses distinct live and draft identities", async () => {
  const f = harness(), a = f.createSend("default"), b = f.createSend("default", { branch: "branch-b" });
  assert.notEqual(a.viewKey, b.viewKey);
  await Promise.all([a.send(), b.send()]); f.finish(a.viewKey, "main"); f.finish(b.viewKey, "branch");
  assert.deepEqual(new Set(f.state.items.map((item) => item.data.branchId)), new Set(["main", "branch-b"]));
});

const deleteSource = stripTypeScriptTypes(source.slice(source.indexOf("  const handleDeleteThread ="), source.indexOf("  useEffect(() => () =>", source.indexOf("  const handleDeleteThread ="))));
function deletionHarness() {
  const url = "/api/session/quick-ask", main = key(url, "main", "default"), feature = key(url, "feature", "default");
  const state = { drafts: { [main]: { question: "main draft", images: ["main image"] }, [feature]: { question: "feature draft", images: ["feature image"] } }, replies: { [main]: { question: "main", answer: "", images: [], thinking: "", running: true }, [feature]: { question: "feature", answer: "", images: [], thinking: "", running: true } }, processingImages: { [main]: 1, [feature]: 1 }, items: [{ id: "main", data: { branchId: "main", threadId: "default" } }, { id: "feature", data: { branchId: "feature", threadId: "default" } }], threadList: ["default", "other"] };
  const mainController = new AbortController(), featureController = new AbortController();
  const streamRequestsRef = { current: new Map([[main, { controller: mainController, running: true }], [feature, { controller: featureController, running: true }]]) }, pendingImageCountRef = { current: new Map([[main, { count: 1 }], [feature, { count: 1 }]]) }, draftsRef = { current: state.drafts }, requests = [];
  let settle; const result = new Promise((resolve) => { settle = resolve; });
  const setter = (name) => (update) => { state[name] = typeof update === "function" ? update(state[name]) : update; if (name === "drafts") draftsRef.current = state.drafts; };
  const context = { quickAskUrl: url, activeBranchId: "main", sideAskBranchId: "main", activeThreadId: "default", threadList: state.threadList, threads: [{ id: "default", label: "1", count: 1 }], sidekickViewKey: key, streamRequestsRef, pendingImageCountRef, draftsRef, sessionIdentityRef: { current: {} }, AbortController, t, window: { confirm: () => true },
    deleteHistory: (body, optimistic) => { requests.push(body); optimistic(); return result; }, setReplies: setter("replies"), setDrafts: setter("drafts"), setItems: setter("items"), setProcessingImages: setter("processingImages"), setThreadList: setter("threadList"), setActiveThreadId: setter("active"), setAttachmentError: setter("error"),
  };
  const remove = vm.runInNewContext(`${deleteSource}\nhandleDeleteThread`, context);
  return { state, remove, settle, main, feature, draftsRef, requests, mainController, featureController, streamRequestsRef, pendingImageCountRef };
}

test("real delete callback scopes cleanup to one branch and keeps the other branch's draft/request/images", async () => {
  const f = deletionHarness(); f.remove({ stopPropagation() {} }, "default");
  assert.equal(f.mainController.signal.aborted, true);
  assert.equal(f.featureController.signal.aborted, false);
  assert.equal(f.requests[0].branchId, "main");
  f.settle(true); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.drafts[f.main], undefined);
  assert.equal(f.state.drafts[f.feature].question, "feature draft");
  assert.equal(f.state.replies[f.feature].running, true);
  assert.equal(f.pendingImageCountRef.current.has(f.feature), true);
  assert.deepEqual(Array.from(f.state.items, (item) => item.id), ["feature"]);
});

test("failed deletion preserves the original unsent question and images", async () => {
  const f = deletionHarness(); f.remove({ stopPropagation() {} }, "default");
  f.settle(false); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.drafts[f.main].question, "main draft");
  assert.deepEqual(f.state.drafts[f.main].images, ["main image"]);
  assert.equal(f.state.drafts[f.feature].question, "feature draft");
  assert.equal(f.state.error, t("sidekick.deleteIncomplete"));
});

test("a duplicate delete is suppressed and user input typed during deletion is retained", async () => {
  const f = deletionHarness(); f.remove({ stopPropagation() {} }, "default"); f.remove({ stopPropagation() {} }, "default");
  assert.equal(f.requests.length, 1);
  const changed = { question: "new input", images: ["new image"] };
  f.state.drafts = { ...f.state.drafts, [f.main]: changed }; f.draftsRef.current = f.state.drafts;
  f.settle(true); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.drafts[f.main], changed);
  assert.equal(f.state.threadList.includes("default"), true);
});

test("deleting a topic carries the exact local admission identity, including before acceptance", async () => {
  const f = deletionHarness();
  const owner = f.streamRequestsRef.current.get(f.main);
  owner.runId = "pending-admission";
  owner.accepted = false;
  f.remove({ stopPropagation() {} }, "default");
  assert.equal(f.requests[0].requestId, "pending-admission");
  assert.equal(f.requests[0].branchId, "main");
  f.settle(true); await new Promise((resolve) => setImmediate(resolve));
});

test("4xx recovery preserves a queued new draft and the entire unsent source in one transition", async () => {
  const f = harness({ queued: true });
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const a = f.createSend("default", { reject: { status: 409, error: "busy", wait } });
  const sending = a.send(); f.flush();
  f.queueDraft(a.viewKey, { question: "queued new draft", images: [], error: null });
  release(); await sending; f.flush();
  assert.equal(f.state.drafts[a.viewKey].question, "queued new draft");
  assert.equal(f.state.replies[a.viewKey]?.question, "question default");
  assert.equal(f.state.replies[a.viewKey].answer, `[${t("sidekick.notSent", { reason: "busy" })}]`);
});

test("4xx recovery reserves a pending new image even if compression finishes before the batch commits", async () => {
  const f = harness({ queued: true });
  let release; const wait = new Promise((resolve) => { release = resolve; });
  const images = Array.from({ length: 10 }, () => ({ data: "AAAA", mimeType: "image/png" }));
  const a = f.createSend("default", { images, reject: { status: 409, error: "busy", wait } });
  const sending = a.send(); f.flush();
  const pending = { count: 1 }; f.pendingImageCountRef.current.set(a.viewKey, pending);
  release(); await sending;
  const nextImage = { data: "BBBB", mimeType: "image/png" };
  f.queueImage(a.viewKey, nextImage); pending.count = 0; f.flush();
  assert.deepEqual(f.state.drafts[a.viewKey].images, [nextImage]);
  assert.equal(f.state.replies[a.viewKey]?.images.length, 10);
  assert.equal(f.state.replies[a.viewKey].question, "question default");
});

test("a lost admission response consumes matching deletion evidence without leaving an unknown reply", async () => {
  const f = harness();
  const a = f.createSend("default", { reject: { status: 500, error: "response lost" }, lookup: async () => Response.json({
    code: "quick_ask_deleted", runId: f.requests[0].body.requestId, threadId: "default", branchId: "main",
  }, { status: 410 }) });
  await a.send(); f.flush();
  assert.equal(f.state.replies[a.viewKey], undefined);
  assert.equal(f.streamRequestsRef.current.has(a.viewKey), false);
  assert.equal(f.requests.length, 1);
});
