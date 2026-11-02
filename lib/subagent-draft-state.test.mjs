import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { collectPendingDrafts, rememberDraft, removeDrafts } = await createJiti(import.meta.url).import("./subagent-draft-state.ts");

test("draft state keeps hidden identities and removes only confirmed saves", () => {
  const first = rememberDraft({}, "project:one", { value: "edited" }, true);
  const pending = collectPendingDrafts(first, "global:two", { value: "new" }, true);
  assert.deepEqual([...pending.keys()], ["project:one", "global:two"]);
  const afterPartialSave = removeDrafts(first, ["project:one"]);
  assert.deepEqual(afterPartialSave, {});
  assert.deepEqual([...pending.keys()], ["project:one", "global:two"], "pending snapshot retains failed/unexecuted drafts");
});

test("clean current draft is removed without touching other drafts", () => {
  const map = { "project:one": { value: "edited" }, "global:two": { value: "kept" } };
  const pending = collectPendingDrafts(map, "project:one", { value: "baseline" }, false);
  assert.deepEqual([...pending.keys()], ["project:one", "global:two"]);
  assert.deepEqual(rememberDraft(map, "project:one", { value: "baseline" }, false), { "global:two": { value: "kept" } });
});
