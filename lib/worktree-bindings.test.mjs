import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  appendWorktreeBinding,
  findWorktreeBindingRecords,
  WORKTREE_BINDING_CUSTOM_TYPE,
} = await jiti.import("./worktree-bindings.ts");

const projectRoot = "/repo";
const worktree = "/repo/.worktrees/task";
const session = { id: "session-owner", name: "Owner" };

function entry(data, timestamp = "2026-01-01T00:00:00.000Z") {
  return { type: "custom", id: `entry-${timestamp}`, parentId: null, timestamp, customType: WORKTREE_BINDING_CUSTOM_TYPE, data };
}

test("reads structured task-root bindings and ignores unregistered paths", () => {
  const records = findWorktreeBindingRecords([
    entry({ version: 1, action: "bind", relation: "task-root", projectRoot, worktreePath: worktree }),
    entry({ version: 1, action: "bind", relation: "task-root", projectRoot, worktreePath: "/repo/.worktrees/unknown" }),
  ], session, projectRoot, [projectRoot, worktree]);
  assert.deepEqual(records, [{ worktreePath: worktree, sessionId: session.id, relation: "task-root", createdAt: "2026-01-01T00:00:00.000Z", sessionName: "Owner" }]);
});

test("latest release removes only the matching relation and path", () => {
  const records = findWorktreeBindingRecords([
    entry({ version: 1, action: "bind", relation: "creator", projectRoot, worktreePath: worktree }, "2026-01-01T00:00:00.000Z"),
    entry({ version: 1, action: "bind", relation: "task-root", projectRoot, worktreePath: worktree }, "2026-01-01T00:00:01.000Z"),
    entry({ version: 1, action: "release", relation: "creator", projectRoot, worktreePath: worktree }, "2026-01-01T00:00:02.000Z"),
  ], session, projectRoot, [worktree]);
  assert.deepEqual(records.map((record) => record.relation), ["task-root"]);
});

test("append is idempotent for the active binding", () => {
  const entries = [entry({ version: 1, action: "bind", relation: "task-root", projectRoot, worktreePath: worktree })];
  const manager = {
    getEntries: () => entries,
    appendCustomEntry(type, data) {
      entries.push(entry(data, "2026-01-01T00:00:01.000Z"));
      assert.equal(type, WORKTREE_BINDING_CUSTOM_TYPE);
      return "new-entry";
    },
  };
  assert.equal(appendWorktreeBinding(manager, { relation: "task-root", projectRoot, worktreePath: worktree }), false);
  assert.equal(entries.length, 1);
  assert.equal(appendWorktreeBinding(manager, { relation: "creator", projectRoot, worktreePath: worktree }), true);
  assert.equal(entries.length, 2);
});
