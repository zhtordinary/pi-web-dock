import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import * as observers from "../lib/quick-ask-observer.ts";
import { loadSidekickHelpers, runSidekickReplyLayout } from "../test-support/sidekick-client-fixture.mjs";
import { testTranslator } from "./test-locale.mjs";

const source = readFileSync(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
const slice = (from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, from);
  return stripTypeScriptTypes(source.slice(start, source.indexOf(to, start)));
};
const sendSource = slice("  const handleSend = async", "  const handleAbort");
const restoreSource = slice("  const handleRestoreQuestion =", "  const handleCopy");
const image = { data: "AAAA", mimeType: "image/png" };
const t = testTranslator("en");

/** The real send and restore handlers; the host is a script of answers to the admission POST. */
function harness({ lookup, branch = "main" } = {}) {
  const identity = { sessionId: "session", quickAskUrl: "/quick-ask" };
  const viewKey = JSON.stringify([identity.quickAskUrl, branch, "a"]);
  const state = { drafts: {}, replies: {}, observed: [], posts: [], gets: [] };
  const script = [];
  const streamRequestsRef = { current: new Map() }, sessionIdentityRef = { current: identity };
  const observeRunRef = { current: (run) => { state.observed.push(run); } };
  const setter = (name) => (value) => { state[name] = typeof value === "function" ? value(state[name]) : value; };
  const setAttachmentError = (error) => { state.drafts[viewKey] = { ...(state.drafts[viewKey] ?? { question: "", images: [] }), error }; };
  const context = {
    streamRequestsRef, sessionIdentityRef, observeRunRef, pendingImageCountRef: { current: new Map() },
    sidekickViewKey: (url, branch, thread) => JSON.stringify([url, branch, thread]),
    readQuickAskRun: observers.readQuickAskRun, AbortController, URL, window: { location: { href: "http://reader.test" } }, t,
    crypto: { randomUUID }, setReplies: setter("replies"), setDrafts: setter("drafts"), setAttachmentError,
    setViewState: (update) => { const next = update({ drafts: state.drafts, replies: state.replies }); state.drafts = next.drafts; state.replies = next.replies; },
    historyController: { invalidate() {}, async load() {} }, restoreQuestionView() {},
    viewKey, question: "original question", attachedImages: [image], isForking: false, isProcessingImages: false, sessionId: "session",
    quickAskUrl: identity.quickAskUrl, activeBranchId: branch, sideAskBranchId: branch, activeThreadId: "a", activeThreadIndex: 0, activeParentId: "leaf",
    requestedModel: { provider: "p", modelId: "m" }, selectedThinkingLevel: "auto",
    setQuestion() {}, setAttachedImages() {},
    draftsRef: { get current() { return state.drafts; } },
    fetch: async (url, options = {}) => {
      if (!options.body) { state.gets.push(url); return lookup ? lookup(url) : Response.json({ error: "Side Ask run not found" }, { status: 404 }); }
      const body = JSON.parse(options.body);
      assert.equal(body.action, "start", "only admission is ever posted here");
      state.posts.push(body);
      const outcome = script.shift() ?? "ok";
      if (outcome === "network") throw new TypeError("network down");
      if (outcome !== "ok") return Response.json({ error: outcome.error }, { status: outcome.status });
      return Response.json({ run: { id: body.requestId, threadId: body.threadId, branchId: body.branchId, question: body.question,
        images: body.images, status: "running", answer: "", thinking: "", createdAt: 1, revision: 0 } });
    },
  };
  loadSidekickHelpers(source, context);
  const send = vm.runInNewContext(`${sendSource}\nhandleSend`, context);
  // Each click sees the reply of the latest render, as the component's handler does.
  const restore = () => {
    const scoped = { ...context, reply: state.replies[viewKey] };
    loadSidekickHelpers(source, scoped);
    return vm.runInNewContext(`${restoreSource}\nhandleRestoreQuestion`, scoped)();
  };
  return { state, script, send, restore, viewKey, streamRequestsRef };
}

test("an unknown admission is sent again as the very same request and then followed", async () => {
  const f = harness();
  f.script.push("network", "ok");
  await f.send();
  assert.equal(f.state.replies[f.viewKey].unconfirmed, true);
  assert.equal(f.state.replies[f.viewKey].running, false);
  assert.equal(f.state.gets.length, 1, "the request ID was looked up first");
  await f.restore();
  assert.equal(f.state.posts.length, 2);
  assert.deepEqual(f.state.posts[1], f.state.posts[0], "same request ID, same question, same options");
  assert.equal(f.state.observed.at(-1).id, f.state.posts[0].requestId);
  assert.equal(f.state.replies[f.viewKey].running, true);
  assert.equal(f.state.replies[f.viewKey].unconfirmed, false);
  assert.equal(f.state.replies[f.viewKey].answer, "", "the stale note is gone while the repeat is in flight");
});

test("a host that refuses the repeat gives the question and its images back", async () => {
  const f = harness();
  f.script.push("network", { status: 409, error: "Quick Ask origin branch changed; retry from the active branch" });
  await f.send();
  await f.restore();
  assert.equal(f.state.replies[f.viewKey], undefined);
  assert.equal(f.state.drafts[f.viewKey].question, "original question");
  assert.deepEqual(f.state.drafts[f.viewKey].images, [image]);
  assert.equal(f.state.drafts[f.viewKey].error, t("sidekick.notSent", { reason: "Quick Ask origin branch changed; retry from the active branch" }));
  runSidekickReplyLayout(source, { streamRequestsRef: f.streamRequestsRef, replies: f.state.replies });
  assert.equal(f.streamRequestsRef.current.has(f.viewKey), false, "the released request leaves no stale entry behind");
});

test("while the host stays unreachable the reply stays unconfirmed and the same request can be tried again", async () => {
  const f = harness();
  f.script.push("network", "network", "ok");
  await f.send();
  await f.restore();
  assert.equal(f.state.replies[f.viewKey].unconfirmed, true);
  assert.equal(f.state.replies[f.viewKey].running, false);
  assert.equal(f.state.posts.length, 2);
  await f.restore();
  assert.equal(f.state.posts.length, 3);
  assert.equal(new Set(f.state.posts.map((post) => post.requestId)).size, 1);
  assert.equal(f.state.observed.length, 1);
});

test("a repeat that is already in flight cannot be started a second time", async () => {
  const f = harness();
  f.script.push("network", "ok");
  await f.send();
  const first = f.restore();
  const second = f.restore();
  await Promise.all([first, second]);
  assert.equal(f.state.posts.length, 2, "the second click saw the reply running and did nothing");
});

test("a turn the host already admitted is only looked up, never sent again", async () => {
  const f = harness({ lookup: () => Response.json({ run: { id: "found", threadId: "a", branchId: "main", question: "original question", images: [],
    status: "running", answer: "partial", thinking: "", createdAt: 1, revision: 1 } }) });
  await f.send();
  const request = f.streamRequestsRef.current.get(f.viewKey);
  assert.equal(request.accepted, true);
  f.state.replies[f.viewKey] = { ...f.state.replies[f.viewKey], running: false, unconfirmed: true };
  f.state.replies[f.viewKey].runId = "found";
  request.runId = "found";
  await f.restore();
  assert.equal(f.state.posts.length, 1);
  assert.equal(f.state.gets.length, 1);
  assert.equal(f.state.observed.at(-1).id, "found");
});

for (const state of ["unconfirmed", "failed", "refused"]) {
  test(`a ${state} branch question stays reachable when its tab becomes the main line`, async () => {
    const chat = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
    const endMarker = "  }, [activeLeafId, activeSideTabId, latestLeafId, session?.id, settleSideAskPromotions, sideTabs]);";
    const end = chat.indexOf(endMarker);
    const start = chat.lastIndexOf("  useEffect(() => {", end);
    assert.ok(start >= 0 && end > start);
    const collapse = stripTypeScriptTypes(chat.slice(start, end + endMarker.length));
    const f = harness({ branch: "side-1" });
    if (state === "unconfirmed") { f.script.push("network"); await f.send(); }
    else if (state === "refused") { f.script.push({ status: 409, error: "refused" }); await f.send(); }
    else f.state.replies[f.viewKey] = { runId: "failed", question: "original question", images: [image],
      answer: "provider failed", thinking: "", running: false };
    assert.ok(f.state.replies[f.viewKey] || f.state.drafts[f.viewKey]?.question, `source exists: ${state}`);
    let active = "side-1", tabs = [{ tabId: "side-1", anchorLeafId: "old" }];
    const localStorage = { setItem() {} };
    vm.runInNewContext(collapse, { useEffect: (fn) => fn(), JSON, localStorage,
      session: { id: "session" }, activeSideTabId: active, activeLeafId: "new", latestLeafId: "new", sideTabs: tabs,
      queueSideAskPromotion() {}, async settleSideAskPromotions() {},
      setActiveSideTabId: (value) => { active = value; }, setSideTabs: (update) => { tabs = update(tabs); },
      sidekickState: f.state,
    });
    const startRecovery = source.indexOf("  const recoveryBranches = useMemo(() => {");
    const endRecovery = source.indexOf("\n  useLayoutEffect(", startRecovery);
    assert.ok(startRecovery >= 0 && endRecovery > startRecovery);
    const recoveryBranches = vm.runInNewContext(stripTypeScriptTypes(source.slice(startRecovery, endRecovery)) + "\nrecoveryBranches", {
      useMemo: (fn) => fn(), promotedBranches: [], items: [], recoveryBranch: null, drafts: f.state.drafts, replies: f.state.replies,
      processingImages: {}, quickAskUrl: "/quick-ask", JSON, Set, Object,
    });
    assert.ok(tabs.some((tab) => tab.tabId === "side-1") || recoveryBranches.includes("side-1"),
      `${state} question must remain reachable after branch collapse (active=${active})`);
    assert.match(source, /aria-label=\{t\("sidekick\.branchAsks"\)\}/);
  });
}

test("the reply names the action it will take", () => {
  assert.match(source, /unconfirmedRequest\?\.resend && !unconfirmedRequest\.accepted \? t\("sidekick\.retrySend"\) : t\("sidekick\.recheckStatus"\)/);
  assert.match(source, /\{restoreActionLabel\}<\/button>/);
});
