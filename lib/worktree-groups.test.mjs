import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { addEmptyWorktreeGroups, groupSessionsByWorktree, sortWorktreeSessionGroups } = await jiti.import("./worktree-groups.ts");
const session = (id, cwd, extra = {}) => ({ id, cwd, projectRoot: "/repo", projectKey: "/repo", isGit: true, ...extra });
test("main first, distinct actual trees stay separate", () => {
  const input = [session("a", "/wt/a", { isWorktree: true, branch: "feature" }), session("b", "/wt/b", { isWorktree: true, branch: "feature" }), session("m", "/repo", { isWorktree: false, branch: "main" })];
  const groups = groupSessionsByWorktree(input, x => x);
  assert.deepEqual(groups.map(g => g.items.map(x => x.id)), [["m"], ["a"], ["b"]]);
  assert.deepEqual(groups.map(g => g.kind), ["main", "worktree", "worktree"]);
  assert.equal(input[0].id, "a");
});
test("device identity, detached trees and missing metadata never collapse unrelated sessions", () => {
  const input = [{ device: "one", session: session("a", "/wt/a", { isWorktree: true }) }, { device: "two", session: session("b", "/wt/a", { isWorktree: true }) }];
  assert.equal(groupSessionsByWorktree(input, x => x.session, x => x.device).length, 2);
  assert.equal(groupSessionsByWorktree([session("n", "/notes", { projectRoot: undefined, projectKey: undefined, isGit: false, isWorktree: false })], x => x)[0].kind, "project");
  assert.deepEqual(groupSessionsByWorktree([], x => x), []);
});
test("non-Git projects stay ordinary projects even with project identity and branch-shaped metadata", () => {
  const groups = groupSessionsByWorktree([
    session("notes", "/notes", { projectRoot: "/notes", projectKey: "/notes", isGit: false, branch: "main", isWorktree: false }),
  ], x => x);
  assert.equal(groups[0].kind, "project");
  assert.equal(groups[0].label, "/notes");
});
test("same actual tree retains input order and its recorded branch label", () => {
  const input = [session("a", "/wt/a", { isWorktree: true, worktreeBranch: "old-peer" }), session("b", "/wt/a", { isWorktree: true, worktreeBranch: "old-peer" })];
  const groups = groupSessionsByWorktree(input, x => x);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "old-peer");
  assert.deepEqual(groups[0].items, input);
});
test("the same branch stays isolated by project and device", () => {
  const input = [
    { device: "one", session: session("a", "/repo-a/lane", { projectRoot: "/repo-a", projectKey: "/repo-a", isWorktree: true, branch: "lane" }) },
    { device: "two", session: session("b", "/repo-a/lane", { projectRoot: "/repo-a", projectKey: "/repo-a", isWorktree: true, branch: "lane" }) },
    { device: "one", session: session("c", "/repo-b/lane", { projectRoot: "/repo-b", projectKey: "/repo-b", isWorktree: true, branch: "lane" }) },
  ];
  const groups = groupSessionsByWorktree(input, x => x.session, x => x.device);
  assert.equal(groups.length, 3);
  assert.equal(new Set(groups.map(group => group.key)).size, 3);
});
test("linked worktrees without sessions get their own rows, scoped like session rows", () => {
  const groups = groupSessionsByWorktree([
    { device: "one", session: session("a", "/repo-worktrees/lane", { isWorktree: true, branch: "lane" }) },
  ], x => x.session, x => x.device);
  addEmptyWorktreeGroups(groups, [
    { path: "/repo-worktrees/lane", branch: "lane" },
    { path: "/repo-worktrees/moved-lane", branch: "lane" },
    { path: "/repo-worktrees/侧边提问", branch: "侧边提问" },
    { path: "/repo-worktrees/detached", branch: null },
  ], "/repo", "one");
  const rows = new Map(sortWorktreeSessionGroups(groups).map(group => [group.path, [group.kind, group.label, group.items.map(item => item.id)]]));
  assert.deepEqual(Object.fromEntries(rows), {
    "/repo-worktrees/lane": ["worktree", "lane", ["a"]],
    "/repo-worktrees/侧边提问": ["worktree", "侧边提问", []],
    "/repo-worktrees/detached": ["worktree", "/repo-worktrees/detached", []],
  });
  addEmptyWorktreeGroups(groups, [{ path: "/repo-worktrees/侧边提问", branch: "侧边提问" }], "/repo", "two");
  assert.equal(groups.filter(group => group.path === "/repo-worktrees/侧边提问").length, 2);
});
