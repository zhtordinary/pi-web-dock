import assert from "node:assert/strict";
import test from "node:test";
import { observeQuickAskRun, requestQuickAskFork } from "./quick-ask-observer.ts";
import { testTranslator } from "../components/test-locale.mjs";
const translate = testTranslator("en");

const initial = () => ({ id: "run", branchId: "main", threadId: "a", question: "question", images: [],
  status: "running", answer: "", thinking: "", revision: 0, createdAt: 1 });
const deleted = (extra = {}) => ({ code: "quick_ask_deleted", error: "该侧问已删除", runId: "run", branchId: "main", threadId: "a", ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function sources() {
  const all = [];
  return { all, create(url) {
    const stream = { url, onmessage: null, onerror: null, closed: false, close() { this.closed = true; } };
    all.push(stream); return stream;
  } };
}

test("a positively identified deleted run closes reconnection without restarting or stopping inference", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sources(), controller = new AbortController(), lookups = [], removed = [];
  observeQuickAskRun({ t: translate, url: "/api/remote/sessions/p/quick-ask?peer=device", run: initial(), signal: controller.signal,
    eventSource: (url) => f.create(url), onRun() {}, onError: assert.fail, onDeleted: () => removed.push("deleted"),
    fetcher: async (url, options) => { lookups.push({ url, options }); return Response.json(deleted(), { status: 410 }); },
  });
  f.all[0].onerror({}); t.mock.timers.tick(1000); await tick();
  assert.equal(removed.length, 1);
  assert.equal(lookups.length, 1);
  assert.match(lookups[0].url, /peer=device/);
  assert.match(lookups[0].url, /runId=run/);
  assert.doesNotMatch(lookups[0].url, /stream=1/);
  assert.equal(lookups[0].options.method ?? "GET", "GET");
  assert.ok(f.all.every((source) => source.closed));
  const count = f.all.length; t.mock.timers.tick(60000); await tick();
  assert.equal(f.all.length, count);
  controller.abort();
});

test("unknown peer, legacy missing state, transient errors and a foreign deletion remain unknown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [status, body] of [
    [404, { error: "Unknown peer: device" }], [404, { error: "Side Ask run not found" }],
    [502, { error: "Remote peer request failed" }], [504, { error: "Remote request timed out" }],
    [410, deleted({ runId: "other" })], [410, deleted({ threadId: "other" })],
  ]) {
    const f = sources(), controller = new AbortController(), removed = [];
    observeQuickAskRun({ t: translate, url: "/quick-ask", run: initial(), signal: controller.signal,
      eventSource: (url) => f.create(url), onRun() {}, onError: assert.fail, onDeleted: () => removed.push(true),
      fetcher: async () => Response.json(body, { status }),
    });
    f.all[0].onerror({}); t.mock.timers.tick(1000); await tick();
    assert.equal(removed.length, 0);
    assert.equal(f.all.length, 2);
    assert.equal(f.all[1].closed, false);
    controller.abort();
  }
});

test("a late deletion lookup is aborted and cannot affect a replacement observer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sources(), controller = new AbortController(), removed = [];
  let resolve, signal;
  observeQuickAskRun({ t: translate, url: "/quick-ask", run: initial(), signal: controller.signal,
    eventSource: (url) => f.create(url), onRun() {}, onError: assert.fail, onDeleted: () => removed.push(true),
    fetcher: (_url, options) => { signal = options.signal; return new Promise((yes) => { resolve = yes; }); },
  });
  f.all[0].onerror({}); t.mock.timers.tick(1000); await tick();
  assert.equal(typeof resolve, "function");
  controller.abort(); assert.equal(signal.aborted, true);
  resolve(Response.json(deleted(), { status: 410 })); await tick();
  assert.equal(removed.length, 0);
});

test("an authoritative deletion rejects a pending whole-topic fork instead of leaving it waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sources(), controller = new AbortController(), methods = [];
  const pending = requestQuickAskFork({ t: translate, url: "/quick-ask", body: { branchId: "main", threadId: "a" }, signal: controller.signal,
    eventSource: (url) => f.create(url), fetcher: async (_url, options) => {
      methods.push(options.method ?? "GET");
      return options.method === "POST"
        ? Response.json({ success: true, pending: true, run: initial() }, { status: 202 })
        : Response.json(deleted(), { status: 410 });
    },
  });
  const observed = pending.then(() => "resolved", (error) => error);
  try {
    await tick(); f.all[0].onerror({}); t.mock.timers.tick(1000); await tick();
    const result = await Promise.race([observed, tick().then(() => "still-pending")]);
    assert.ok(result instanceof Error, `fork must finish with the deletion error, received ${String(result)}`);
    assert.equal(result.message, translate("sidekick.forkDeleted"));
    assert.deepEqual(methods, ["POST", "GET"]);
  } finally { controller.abort(); await observed; }
});

test("a completed JSON reconciliation restores the same public entry and closes the observer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sources(), controller = new AbortController(), views = [];
  const image = { data: "AAAA", mimeType: "image/png" };
  const run = { ...initial(), images: [image] };
  const entry = { id: "entry", requestedModel: { provider: "alias", modelId: "intent" }, data: {
    threadId: "a", branchId: "main", question: "question", answer: "recovered answer",
  } };
  observeQuickAskRun({ t: translate, url: "/quick-ask", run, signal: controller.signal,
    eventSource: (url) => f.create(url), onRun: (next) => views.push(next), onError: assert.fail, onDeleted: assert.fail,
    fetcher: async () => Response.json({ run: { ...run, status: "completed", answer: "recovered answer", revision: 3, entry } }),
  });
  f.all[0].onerror({}); t.mock.timers.tick(1000); await tick();
  assert.equal(views.at(-1).status, "completed");
  assert.equal(views.at(-1).entry.data.answer, "recovered answer");
  assert.deepEqual(views.at(-1).entry.requestedModel, entry.requestedModel);
  assert.deepEqual(views.at(-1).entry.data.images, [image]);
  assert.ok(f.all.every((source) => source.closed));
  controller.abort();
});
