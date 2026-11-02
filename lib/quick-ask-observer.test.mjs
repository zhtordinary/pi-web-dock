import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { testTranslator } from "../components/test-locale.mjs";
const translate = testTranslator("en");
const { localizeQuickAskError, observeQuickAskRun, requestQuickAskFork } = await createJiti(import.meta.url).import("./quick-ask-observer.ts");
const initial = () => ({ id: "run-one", threadId: "thread", branchId: "main", question: "question", images: [],
  answer: "", thinking: "", status: "running", createdAt: 1, revision: 0 });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function factory() {
  const sources = [];
  return { sources, create(url) {
    const source = { url, closed: 0, onmessage: null, onerror: null,
      close() { this.closed++; }, emit(value) { this.onmessage?.({ data: JSON.stringify(value) }); } };
    sources.push(source);
    return source;
  } };
}

test("known Side Ask host errors follow the UI locale while unknown provider text is preserved", () => {
  const cases = [
    ["该侧问正在转出或已转为独立会话", "sidekick.hostTransferInProgress"],
    ["该话题正在回答，请等待完成或显式停止", "sidekick.hostTopicBusy"],
    ["已停止", "sidekick.stopped"],
    ["该侧问已删除", "sidekick.runDeleted"],
  ];
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const t = testTranslator(locale);
    for (const [raw, key] of cases) assert.equal(localizeQuickAskError(raw, t), t(key));
    assert.equal(localizeQuickAskError("模型提供方的自定义错误", t), "模型提供方的自定义错误");
    assert.equal(localizeQuickAskError("已停止; 保存失败: disk full", t), t("sidekick.stopped") + t("sidekick.hostSaveFailurePrefix") + "disk full");
  }
});

test("authoritative snapshots replace progress and duplicate deltas never repeat text", () => {
  const f = factory(), abort = new AbortController(), views = [], errors = [];
  const detach = observeQuickAskRun({ t: translate, url: "/api/remote/sessions/p/quick-ask?peer=remote", run: initial(), signal: abort.signal,
    eventSource: (url) => f.create(url), onRun: (run) => views.push(run), onError: (error) => errors.push(error) });
  const source = f.sources[0];
  assert.match(source.url, /peer=remote/);
  assert.match(source.url, /runId=run-one/);
  source.emit({ type: "snapshot", run: { ...initial(), answer: "restored", revision: 3 } });
  source.emit({ type: "chunk", runId: "run-one", revision: 4, delta: " tail" });
  source.emit({ type: "chunk", runId: "run-one", revision: 4, delta: " duplicate" });
  source.emit({ type: "snapshot", run: { ...initial(), answer: "stale", revision: 2 } });
  assert.equal(views.at(-1).answer, "restored tail");
  assert.equal(errors.length, 0);
  abort.abort();
  detach();
  assert.equal(source.closed, 1);
});

test("closed HTTP/network streams reconnect to the same run without restarting inference", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = factory(), abort = new AbortController(), views = [];
  observeQuickAskRun({ t: translate, url: "/api/sessions/p/quick-ask", run: initial(), signal: abort.signal,
    eventSource: (url) => f.create(url), onRun: (run) => views.push(run), onError: assert.fail });
  f.sources[0].onerror({});
  f.sources[0].emit({ type: "chunk", runId: "run-one", revision: 1, delta: "closed stream" });
  assert.equal(views.at(-1).answer, "");
  t.mock.timers.tick(1000);
  assert.equal(f.sources.length, 2);
  assert.equal(f.sources[0].url, f.sources[1].url);
  f.sources[1].emit({ type: "snapshot", run: { ...initial(), status: "completed", answer: "saved result", revision: 10 } });
  assert.equal(views.at(-1).status, "completed");
  assert.equal(f.sources[1].closed, 1);
  t.mock.timers.tick(60000);
  assert.equal(f.sources.length, 2);
});

test("missing delta revisions reconnect for a snapshot rather than silently dropping text", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = factory(), abort = new AbortController(), views = [];
  observeQuickAskRun({ t: translate, url: "/api/sessions/p/quick-ask", run: initial(), signal: abort.signal,
    eventSource: (url) => f.create(url), onRun: (run) => views.push(run), onError: assert.fail });
  f.sources[0].emit({ type: "chunk", runId: "run-one", revision: 3, delta: "not a complete transcript" });
  assert.equal(views.at(-1).answer, "");
  t.mock.timers.tick(1000);
  f.sources[1].emit({ type: "snapshot", run: { ...initial(), revision: 3, answer: "complete restored transcript" } });
  assert.equal(views.at(-1).answer, "complete restored transcript");
  abort.abort();
});

test("interruption after process loss is terminal even below the live-only revision", () => {
  const f = factory(), abort = new AbortController(), views = [];
  observeQuickAskRun({ t: translate, url: "/api/sessions/p/quick-ask", run: { ...initial(), answer: "live", revision: 12 }, signal: abort.signal,
    eventSource: (url) => f.create(url), onRun: (run) => views.push(run), onError: assert.fail });
  f.sources[0].emit({ type: "snapshot", run: { ...initial(), status: "interrupted", error: "runtime ended" } });
  assert.equal(views.at(-1).status, "interrupted");
  assert.equal(f.sources[0].closed, 1);
});

test("a mismatched owner is rejected and an aborted observer creates no connection", () => {
  const f = factory(), abort = new AbortController(), errors = [];
  observeQuickAskRun({ t: translate, url: "/api/sessions/p/quick-ask", run: initial(), signal: abort.signal,
    eventSource: (url) => f.create(url), onRun() {}, onError: (error) => errors.push(error) });
  f.sources[0].emit({ type: "snapshot", run: { ...initial(), threadId: "wrong" } });
  assert.equal(errors.length, 1);
  assert.equal(f.sources[0].closed, 1);
  abort.abort();
  observeQuickAskRun({ t: translate, url: "/api/sessions/p/quick-ask", run: initial(), signal: abort.signal,
    eventSource: (url) => f.create(url), onRun: assert.fail, onError: assert.fail });
  assert.equal(f.sources.length, 1);
});

test("conversion observes its side turn across short HTTP requests and never submits another question", async () => {
  const f = factory(), abort = new AbortController(), requests = [];
  const promise = requestQuickAskFork({ t: translate, url: "/api/remote/sessions/p/quick-ask?peer=remote", signal: abort.signal,
    body: { threadId: "thread", branchId: "main" }, eventSource: (url) => f.create(url),
    fetcher: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1
        ? Response.json({ success: true, pending: true, run: initial() }, { status: 202 })
        : Response.json({ success: true, newSessionId: "fork", newSessionPath: "/synthetic/fork.jsonl", entriesCount: 4 });
    },
  });
  await tick();
  assert.equal(f.sources.length, 1);
  f.sources[0].emit({ type: "snapshot", run: { ...initial(), status: "completed", revision: 5 } });
  const result = await promise;
  assert.equal(result.newSessionId, "fork");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((body) => body.action === "fork" && body.wait === false));
  assert.equal(f.sources[0].closed, 1);
});

test("closing a conversion observer never emits a stop command", async () => {
  const f = factory(), abort = new AbortController(), requests = [];
  const promise = requestQuickAskFork({ t: translate, url: "/api/sessions/p/quick-ask", signal: abort.signal,
    body: { threadId: "thread", branchId: "main" }, eventSource: (url) => f.create(url),
    fetcher: async (_url, options) => { requests.push(JSON.parse(options.body)); return Response.json({ success: true, pending: true, run: initial() }, { status: 202 }); },
  });
  const rejected = assert.rejects(promise, (error) => error?.name === "AbortError");
  await tick();
  abort.abort();
  await rejected;
  assert.equal(f.sources[0].closed, 1);
  assert.deepEqual(requests.map((body) => body.action), ["fork"]);
});
