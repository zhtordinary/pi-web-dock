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

test("reload reminders survive panel recreation and are isolated by peer and session", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => descriptor ? Object.defineProperty(globalThis, "window", descriptor) : delete globalThis.window);
  const values = new Map();
  globalThis.window = { sessionStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  } };
  const loader = createJiti(import.meta.url, { moduleCache: false });
  const first = await loader.import("./subagent-draft-state.ts");
  first.setPendingSubagentReload("session", "peer-a", true);
  const reopened = await loader.import("./subagent-draft-state.ts");
  assert.equal(reopened.hasPendingSubagentReload("session", "peer-a"), true);
  assert.equal(reopened.hasPendingSubagentReload("session", "peer-b"), false);
  assert.equal(reopened.hasPendingSubagentReload("other", "peer-a"), false);
  const beforeReload = reopened.pendingSubagentReloadToken("session", "peer-a");
  first.setPendingSubagentReload("session", "peer-a", true);
  assert.notEqual(reopened.pendingSubagentReloadToken("session", "peer-a"), beforeReload, "a concurrent change must not be cleared by an older reload");
  reopened.setPendingSubagentReload("session", "peer-a", false);
  assert.equal(values.size, 0);
});

test("clean current draft is removed without touching other drafts", () => {
  const map = { "project:one": { value: "edited" }, "global:two": { value: "kept" } };
  const pending = collectPendingDrafts(map, "project:one", { value: "baseline" }, false);
  assert.deepEqual([...pending.keys()], ["project:one", "global:two"]);
  assert.deepEqual(rememberDraft(map, "project:one", { value: "baseline" }, false), { "global:two": { value: "kept" } });
});
