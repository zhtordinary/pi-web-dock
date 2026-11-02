import assert from "node:assert/strict";
import test from "node:test";
import { sessionExecutionState, stopSessionExecution } from "./session-execution.ts";
const idle = { parentActive: false, retrying: false, unattended: false, backgroundRunIds: [], queuedCount: 0 };
test("execution includes background and retry work independently of parent input", () => {
  assert.equal(sessionExecutionState(idle).active, false);
  assert.equal(sessionExecutionState({ ...idle, backgroundRunIds: ["child"] }).active, true);
  assert.equal(sessionExecutionState({ ...idle, retrying: true }).active, true);
});
test("a stop acknowledgement never proves a still-active child has exited", async () => {
  const result = await stopSessionExecution({ snapshot: () => sessionExecutionState({ ...idle, backgroundRunIds: ["child"] }), stopParent: async () => {}, stopBackground: async () => {} }, 0);
  assert.equal(result.stopped, false);
  assert.deepEqual(result.state.backgroundRunIds, ["child"]);
});
test("stop covers parent, retry and all owned children, preserving queued input", async () => {
  let parent = true, retrying = true;
  const children = new Set(["a", "b"]), stopped = [];
  const result = await stopSessionExecution({
    snapshot: () => sessionExecutionState({ ...idle, parentActive: parent, retrying, backgroundRunIds: [...children], queuedCount: 2 }),
    stopParent: async () => { parent = false; retrying = false; },
    stopBackground: async id => { stopped.push(id); children.delete(id); },
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(stopped, ["a", "b"]);
  assert.equal(result.state.queuedCount, 2);
});
test("parent failure does not prevent stopping children and is not reported as success", async () => {
  let child = true;
  const result = await stopSessionExecution({
    snapshot: () => sessionExecutionState({ ...idle, parentActive: true, backgroundRunIds: child ? ["a"] : [] }),
    stopParent: async () => { throw new Error("abort failed"); },
    stopBackground: async () => { child = false; },
  }, 0);
  assert.equal(child, false); assert.equal(result.stopped, false); assert.deepEqual(result.errors, ["abort failed"]);
});
test("stop waits for observed termination after acknowledgement", async () => {
  let active = true;
  const result = await stopSessionExecution({
    snapshot: () => sessionExecutionState({ ...idle, backgroundRunIds: active ? ["a"] : [] }),
    stopParent: async () => {},
    stopBackground: async () => { setTimeout(() => { active = false; }, 5); },
  }, 1_000);
  assert.equal(result.stopped, true); assert.equal(active, false);
});
