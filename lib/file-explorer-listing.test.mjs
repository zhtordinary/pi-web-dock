import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createLatestFileListing } = await jiti.import("./file-explorer-listing.ts");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function view() {
  const state = { loading: false, entries: [], error: null, finishes: 0 };
  return { state, handlers: {
    start: () => { state.loading = true; state.error = null; },
    success: (entries) => { state.entries = entries; },
    error: (error) => { state.error = error.message; },
    finish: () => { state.loading = false; state.finishes += 1; },
  } };
}

test("a late old directory response cannot undo a newer hidden-file filter or sorting", async () => {
  const requests = createLatestFileListing();
  const old = deferred(), next = deferred(), ui = view();
  let oldSignal;
  const first = requests.run((signal) => { oldSignal = signal; return old.promise; }, ui.handlers);
  const second = requests.run(() => next.promise, ui.handlers);
  assert.equal(oldSignal.aborted, true);
  next.resolve(["a", "z"]);
  await second;
  old.resolve(["ignored", "z", "a"]); // Transport can ignore AbortSignal.
  await first;
  assert.deepEqual(ui.state, { loading: false, entries: ["a", "z"], error: null, finishes: 1 });
});

test("an old failure cannot clear a newer listing's loading state", async () => {
  const requests = createLatestFileListing();
  const old = deferred(), next = deferred(), ui = view();
  const first = requests.run(() => old.promise, ui.handlers);
  const second = requests.run(() => next.promise, ui.handlers);
  old.reject(new Error("old peer failed"));
  await first;
  assert.equal(ui.state.loading, true);
  assert.equal(ui.state.error, null);
  assert.equal(ui.state.finishes, 0);
  next.resolve(["current"]);
  await second;
  assert.equal(ui.state.loading, false);
  assert.deepEqual(ui.state.entries, ["current"]);
});

test("unmount cancellation prevents all later state writes", async () => {
  const requests = createLatestFileListing();
  const load = deferred(), ui = view();
  const task = requests.run(() => load.promise, ui.handlers);
  requests.cancel();
  const before = structuredClone(ui.state);
  load.resolve(["stale"]);
  await task;
  assert.deepEqual(ui.state, before);
});
