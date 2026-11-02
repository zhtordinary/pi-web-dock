import assert from "node:assert/strict";
import test from "node:test";
import { BranchNavigation, canWriteBranch, matchesExpectedLeaf } from "./branch-navigation.ts";

function readyAt(id = "current") {
  const branch = new BranchNavigation();
  branch.reset("local:A");
  branch.observeRuntime(id);
  return branch;
}

test("preview changes only the viewed leaf and keeps writes blocked", async () => {
  const branch = readyAt("runtime");
  assert.equal(await branch.preview("preview", async () => true), true);
  assert.equal(branch.state.runtimeLeafId, "runtime");
  assert.equal(branch.state.viewedLeafId, "preview");
  assert.equal(branch.state.phase, "preview");
  assert.equal(canWriteBranch(branch.state), false);
});

test("navigation requires an exact server acknowledgement and loaded context", async () => {
  const branch = readyAt("runtime");
  await branch.preview("preview", async () => true);
  let loaded = false;
  const result = await branch.navigate("preview", async () => ({ cancelled: false, leafId: "different" }), async () => { loaded = true; return true; });
  assert.equal(result, null);
  assert.equal(loaded, false);
  assert.equal(branch.state.phase, "unknown");
  assert.equal(canWriteBranch(branch.state), false);
});

test("matching navigation remains unknown if loading the acknowledged context fails", async () => {
  const branch = readyAt("runtime");
  await branch.preview("preview", async () => true);
  const result = await branch.navigate("preview", async () => ({ cancelled: false, leafId: "preview" }), async () => false);
  assert.equal(result, null);
  assert.equal(branch.state.runtimeLeafId, "runtime");
  assert.equal(branch.state.phase, "unknown");
});

test("cancelled navigation never reports success or moves the runtime cursor", async () => {
  const branch = readyAt("runtime");
  await branch.preview("preview", async () => true);
  const result = await branch.navigate("preview", async () => ({ cancelled: true, leafId: "runtime" }), async () => true);
  assert.equal(result?.cancelled, true);
  assert.equal(branch.state.runtimeLeafId, "runtime");
  assert.equal(branch.state.viewedLeafId, "preview");
  assert.equal(branch.state.phase, "preview");
});

test("recovery requires a settled server cursor and supports the null root", async () => {
  const branch = readyAt("runtime");
  branch.markUnconfirmed(new Error("lost acknowledgement"));
  assert.equal(await branch.recover(async () => ({ leafId: null, pending: true }), async () => true), false);
  assert.equal(branch.state.phase, "unknown");
  assert.equal(await branch.recover(async () => ({ leafId: null, pending: false }), async (id) => id === null), true);
  assert.deepEqual(branch.state, { phase: "current", runtimeLeafId: null, viewedLeafId: null, ready: true, error: null });
  assert.equal(canWriteBranch(branch.state), true);
});

test("stale metadata after the expected cursor is allowed, but a new message is not", () => {
  const entries = {
    label: { type: "label", parentId: "answer" },
    answer: { type: "message", parentId: "user" },
    user: { type: "message", parentId: null },
  };
  const manager = { getLeafId: () => "label", getEntry: (id) => entries[id] };
  assert.equal(matchesExpectedLeaf(manager, "answer"), true);
  assert.equal(matchesExpectedLeaf(manager, "user"), false);
  assert.equal(matchesExpectedLeaf(manager, null), false);
  assert.equal(matchesExpectedLeaf({ getLeafId: () => null }, null), true);
});

test("new-session model and thinking metadata do not reject its first prompt", () => {
  const entries = { model: { type: "model_change", parentId: null }, thinking: { type: "thinking_level_change", parentId: "model" } };
  const manager = { getLeafId: () => "thinking", getEntry: id => entries[id] };
  assert.equal(matchesExpectedLeaf(manager, null), true);
  entries.model = { type: "message", parentId: null };
  assert.equal(matchesExpectedLeaf(manager, null), false);
});

test("before-message navigation accepts only an independently acknowledged parent", async () => {
  const branch = readyAt("runtime");
  const result = await branch.navigate(undefined,
    async () => ({ cancelled: false, expectedLeafId: "parent", leafId: "parent" }),
    async id => id === "parent");
  assert.equal(result?.leafId, "parent");
  assert.equal(canWriteBranch(branch.state), true);

  for (const ack of [
    { cancelled: false, leafId: "parent" },
    { cancelled: false, expectedLeafId: "other", leafId: "parent" },
    { cancelled: false, expectedLeafId: 42, leafId: "parent" },
  ]) {
    const rejected = readyAt("runtime");
    assert.equal(await rejected.navigate(undefined, async () => ack, async () => true), null);
    assert.equal(canWriteBranch(rejected.state), false);
  }
});

test("navigation accepts a metadata leaf when the server confirms the requested cursor", async () => {
  const branch = readyAt("runtime");
  let loadedLeaf = null;
  const result = await branch.navigate("answer",
    async () => ({ cancelled: false, expectedLeafId: "answer", metadataLeaf: true, leafId: "metadata" }),
    async leafId => {
      loadedLeaf = leafId;
      return true;
    });
  assert.equal(result?.leafId, "metadata");
  assert.equal(loadedLeaf, "metadata");
  assert.equal(branch.state.runtimeLeafId, "metadata");
  assert.equal(canWriteBranch(branch.state), true);
});

test("runtime setting metadata permits the confirmed message cursor, not a different branch", () => {
  const entries = { model: { type: "model_change", parentId: "answer" }, answer: { type: "message", parentId: "question" }, question: { type: "message", parentId: null } };
  const manager = { getLeafId: () => "model", getEntry: id => entries[id] };
  assert.equal(matchesExpectedLeaf(manager, "answer"), true);
  assert.equal(matchesExpectedLeaf(manager, "question"), false);
  assert.equal(matchesExpectedLeaf(manager, "other-branch"), false);
});
