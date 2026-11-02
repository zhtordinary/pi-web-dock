import assert from "node:assert/strict";
import test from "node:test";
import { observeQuickAskRun } from "./quick-ask-observer.ts";
import { testTranslator } from "../components/test-locale.mjs";
const translate = testTranslator("en");

const initial = () => ({ id: "run", branchId: "main", threadId: "a", question: "question", images: [],
  status: "running", answer: "", thinking: "", revision: 0, createdAt: 1 });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function sources() {
  const all = [];
  return { all, create(url) {
    const stream = { url, onmessage: null, onerror: null, closed: false, close() { this.closed = true; } };
    all.push(stream); return stream;
  } };
}
const snapshot = (stream, run) => stream.onmessage({ data: JSON.stringify({ type: "snapshot", run }) });

test("a healthy stream is never second-guessed, and a stale reading cannot roll the view back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sources(), controller = new AbortController(), seen = [], lookups = [];
  let reading = { ...initial(), revision: 2, answer: "old" };
  observeQuickAskRun({ t: translate, url: "/quick-ask", run: initial(), signal: controller.signal, eventSource: (url) => f.create(url),
    onRun: (run) => seen.push([run.status, run.revision, run.answer]), onError: assert.fail,
    fetcher: async (url) => { lookups.push(url); return Response.json({ run: reading }); } });
  snapshot(f.all[0], { ...initial(), revision: 5, answer: "live" });
  t.mock.timers.tick(60_000); await tick();
  assert.equal(lookups.length, 0, "no read happens while the stream works");

  f.all[0].onerror({}); t.mock.timers.tick(1000); await tick();
  assert.equal(lookups.length, 1);
  assert.deepEqual(seen.at(-1), ["running", 5, "live"], "an older running reading is ignored");

  reading = { ...initial(), status: "interrupted", error: "Reader runtime ended before this Side Ask finished", revision: 1 };
  f.all[1].onerror({}); t.mock.timers.tick(2000); await tick();
  assert.equal(seen.at(-1)[0], "interrupted", "a reading that proves the end is authoritative even with a lower revision");
  assert.ok(f.all.every((source) => source.closed));
  controller.abort();
});

test("a reading of another topic's run is treated as unknown and the stream keeps retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sources(), controller = new AbortController(), seen = [];
  observeQuickAskRun({ t: translate, url: "/quick-ask", run: initial(), signal: controller.signal, eventSource: (url) => f.create(url),
    onRun: (run) => seen.push(run.id), onError: assert.fail,
    fetcher: async () => Response.json({ run: { ...initial(), threadId: "other", revision: 9, status: "failed" } }) });
  f.all[0].onerror({}); t.mock.timers.tick(1000); await tick();
  assert.deepEqual(seen, ["run"], "only the initial snapshot was ever shown");
  assert.equal(f.all.length, 2);
  assert.equal(f.all[1].closed, false);
  controller.abort();
});

test("two failures in a row never overlap their readings", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = sources(), controller = new AbortController();
  let open = 0, peak = 0;
  observeQuickAskRun({ t: translate, url: "/quick-ask", run: initial(), signal: controller.signal, eventSource: (url) => f.create(url),
    onRun() {}, onError: assert.fail,
    fetcher: async () => { open++; peak = Math.max(peak, open); await new Promise((resolve) => setImmediate(resolve)); open--; return Response.json({ error: "down" }, { status: 502 }); } });
  f.all[0].onerror({}); t.mock.timers.tick(1000);
  f.all[1].onerror({}); t.mock.timers.tick(2000); await tick(); await tick();
  assert.equal(peak, 1);
  controller.abort();
});
