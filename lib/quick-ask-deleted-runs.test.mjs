import assert from "node:assert/strict";
import test from "node:test";
import { log } from "../test-support/quick-ask-fixture.mjs";

let counter = 0;
const custom = (customType, data, extra = {}) => ({ type: "custom", id: extra.id ?? `entry-${++counter}`, parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z", customType, data, ...extra });
const admit = (id, threadId = "a", branchId = "main") => custom("quick_ask_run", { id, threadId, branchId, status: "running" });
const complete = (id, runId, threadId = "a", branchId = "main") => custom("quick_ask", { runId, threadId, branchId }, { id });
const dropThread = (threadId = "a", branchId = "main", requestId) => custom("quick_ask_thread_delete", { threadId, branchId, ...(requestId ? { requestId } : {}) });
const dropOne = (targetId) => custom("quick_ask_delete", { targetId });
const deleted = (entries) => [...log.quickAskDeletedRuns(entries).keys()].sort();

test("a topic deletion covers the runs admitted before it and nothing admitted after it", () => {
  const entries = [admit("R1"), dropThread(), admit("R2")];
  assert.deepEqual(deleted(entries), ["R1"]);
  assert.deepEqual(log.quickAskRunSnapshots(entries, [], false).map((run) => run.id), ["R2"]);
});

test("a single deletion maps its stored answer back to the run that produced it, in either record order", () => {
  assert.deepEqual(deleted([admit("R1"), complete("E1", "R1"), admit("R2"), complete("E2", "R2"), dropOne("E1")]), ["R1"]);
  assert.deepEqual(deleted([admit("R1"), dropOne("E1"), complete("E1", "R1")]), ["R1"], "a tombstone that precedes its answer still applies");
  const legacy = { type: "custom", id: "old", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "quick_ask_delete", targetId: "E1" };
  assert.deepEqual(deleted([admit("R1"), complete("E1", "R1"), legacy]), ["R1"], "historical top-level tombstones count too");
});

test("an exact request identity is blocked only for the topic that named it", () => {
  assert.deepEqual(deleted([dropThread("a", "main", "never-admitted")]), ["never-admitted"]);
  const entries = [admit("R9", "b"), dropThread("a", "main", "R9")];
  assert.deepEqual(deleted(entries), [], "a request known in another topic cannot be cancelled from here");
  assert.equal(log.quickAskDeletedRuns([dropThread("a", "main", "R")]).get("R").threadId, "a");
});

test("deletions never reach other threads or other branches", () => {
  const entries = [admit("A"), admit("B", "b"), admit("C", "a", "feature"), dropThread("a", "main")];
  assert.deepEqual(deleted(entries), ["A"]);
});

test("repeating a deletion changes nothing", () => {
  const entries = [admit("R1"), complete("E1", "R1"), dropOne("E1"), dropOne("E1"), dropThread(), dropThread()];
  assert.deepEqual(deleted(entries), ["R1"]);
});

test("records without the optional fields of older versions are still read", () => {
  const bare = [custom("quick_ask_run", { id: "R1", status: "running" }), custom("quick_ask_thread_delete", undefined)];
  assert.doesNotThrow(() => log.quickAskDeletedRuns(bare));
  assert.deepEqual(deleted([custom("quick_ask_run", { id: "R1" }), custom("quick_ask_thread_delete", {})]), ["R1"], "missing scope fields mean the default topic on main");
});
