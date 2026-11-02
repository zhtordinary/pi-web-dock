import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorktreeNodePrompt,
  attachDirtySummaryProjection,
  classifyWorktreeSource,
  computeWorktreeGraphFromDag,
  deriveWorktreeLabel,
  worktreeLaneColor,
  WORKTREE_LANE_COLORS,
} from "./worktree-graph-types.ts";

test("deriveWorktreeLabel handles various worktree paths and branch formats", () => {
  assert.equal(deriveWorktreeLabel("/repo", "reader", true), "reader");
  assert.equal(deriveWorktreeLabel("/home/alice/repo-worktrees/side-ask", "侧边提问", false), "侧边提问");
  assert.equal(deriveWorktreeLabel("/home/alice/repo-worktrees/detached", null, false), "detached");
  assert.equal(
    deriveWorktreeLabel("/home/alice/.pi-collab-integration-0cba7a564c54/worktree", null, false),
    "integration-0cba7a564c54",
  );
  assert.equal(
    deriveWorktreeLabel("/home/alice/pi-web-reader-tasks/chat-scroll-anchor-stable-key", "task/chat-scroll", false),
    "task/chat-scroll",
  );
});

test("classifyWorktreeSource correctly identifies source categories", () => {
  assert.equal(classifyWorktreeSource("/repo", "main", true), "main");
  assert.equal(classifyWorktreeSource("/home/alice/.devspace/worktrees/proj-123", null, false), "devspace");
  assert.equal(classifyWorktreeSource("/home/alice/pi-web-reader-integrations/lane-a", "integrate/lane-a", false), "integration");
  assert.equal(classifyWorktreeSource("/home/alice/pi-web-reader-tasks/task-1", "task/t1", false), "task");
  assert.equal(classifyWorktreeSource("/home/alice/repo-worktrees/feat", "feature/foo", false), "worktree");
  assert.equal(classifyWorktreeSource("/home/alice/repo-worktrees/session-abc", "session/abc", false), "worktree");
});

test("worktreeLaneColor maps deterministically into the color palette", () => {
  assert.equal(worktreeLaneColor(0), WORKTREE_LANE_COLORS[0]);
  assert.equal(worktreeLaneColor(WORKTREE_LANE_COLORS.length), WORKTREE_LANE_COLORS[0]);
  assert.equal(worktreeLaneColor(-1), WORKTREE_LANE_COLORS[1]);
});

test("computeWorktreeGraphFromDag resolves main, active, merged, and at_base topologies", () => {
  // Synthetic DAG:
  // m3 (mainHead) -> m2 -> m1 -> m0 (initial)
  // b1: forked at m1, committed b1_c1, merged into m3
  // b2: forked at m2, committed b2_c1, b2_c2 (unmerged / active)
  // b3: sitting at m2 with 0 commits (at_base)
  const dagLines = [
    "m3 m2 b1_c1", // m3 is merge commit of m2 and b1_c1
    "m2 m1",
    "m1 m0",
    "m0",
    "b1_c1 m1", // b1 branched from m1
    "b2_c2 b2_c1",
    "b2_c1 m2", // b2 branched from m2
  ];

  const rawWorktrees = [
    { path: "/repo/main", branch: "main", head: "m3", isMain: true },
    { path: "/repo/wt-b1", branch: "feat/b1", head: "b1_c1", isMain: false },
    { path: "/repo/wt-b2", branch: "feat/b2", head: "b2_c2", isMain: false },
    { path: "/repo/wt-b3", branch: "feat/b3", head: "m2", isMain: false },
  ];

  const commitMeta = new Map([
    ["m3", { timestamp: 300, isoDate: "2026-09-30T03:00:00Z", author: "Dev", subject: "Merge b1 into main" }],
    ["m2", { timestamp: 200, isoDate: "2026-09-30T02:00:00Z", author: "Dev", subject: "Mainline commit 2" }],
    ["m1", { timestamp: 100, isoDate: "2026-09-30T01:00:00Z", author: "Dev", subject: "Mainline commit 1" }],
    ["m0", { timestamp: 50, isoDate: "2026-09-30T00:50:00Z", author: "Dev", subject: "Initial commit" }],
    ["b1_c1", { timestamp: 150, isoDate: "2026-09-30T01:30:00Z", author: "Alice", subject: "Feature 1 done" }],
    ["b2_c1", { timestamp: 220, isoDate: "2026-09-30T02:20:00Z", author: "Bob", subject: "Feature 2 start" }],
    ["b2_c2", { timestamp: 250, isoDate: "2026-09-30T02:50:00Z", author: "Bob", subject: "Feature 2 wip" }],
  ]);

  const graph = computeWorktreeGraphFromDag("/repo/main", rawWorktrees, dagLines, commitMeta);

  assert.equal(graph.projectRoot, "/repo/main");
  assert.equal(graph.targetBranch, "main");
  assert.equal(graph.mainHead, "m3");
  assert.equal(graph.deltaBasis, "topology-fork-base-first-parent");
  assert.equal(graph.totalWorktrees, 4);
  assert.deepEqual(graph.counts, { main: 1, active: 1, merged: 1, atBase: 1 });

  const mainItem = graph.worktrees.find((w) => w.path === "/repo/main");
  assert.ok(mainItem);
  assert.equal(mainItem.status, "main");
  assert.equal(mainItem.baseCommit, "m3");
  assert.equal(mainItem.ahead, 0);

  const b1Item = graph.worktrees.find((w) => w.path === "/repo/wt-b1");
  assert.ok(b1Item);
  assert.equal(b1Item.status, "merged");
  assert.equal(b1Item.baseCommit, "m1");
  assert.equal(b1Item.mergedIntoCommit, "m3");
  assert.equal(b1Item.ahead, 1);
  assert.equal(b1Item.shortMergedInto, "m3");

  const b2Item = graph.worktrees.find((w) => w.path === "/repo/wt-b2");
  assert.ok(b2Item);
  assert.equal(b2Item.status, "active");
  assert.equal(b2Item.baseCommit, "m2");
  assert.equal(b2Item.ahead, 2);
  assert.equal(b2Item.mergedIntoCommit, null);

  const b3Item = graph.worktrees.find((w) => w.path === "/repo/wt-b3");
  assert.ok(b3Item);
  assert.equal(b3Item.status, "at_base");
  assert.equal(b3Item.baseCommit, "m2");
  assert.equal(b3Item.ahead, 0);
  assert.equal(b3Item.mergedIntoCommit, null);

  // Check timeline spine nodes
  const nodeShas = graph.nodes.map((n) => n.sha);
  assert.ok(nodeShas.includes("m3"));
  assert.ok(nodeShas.includes("m2"));
  assert.ok(nodeShas.includes("m1"));

  const m3Node = graph.nodes.find((n) => n.sha === "m3");
  assert.ok(m3Node?.isMainHead);
  assert.deepEqual(m3Node?.mainPaths, ["/repo/main"]);
  assert.deepEqual(m3Node?.mergedPaths, ["/repo/wt-b1"]);

  const m2Node = graph.nodes.find((n) => n.sha === "m2");
  assert.deepEqual(m2Node?.fanOutPaths, ["/repo/wt-b2"]);
  assert.deepEqual(m2Node?.atBasePaths, ["/repo/wt-b3"]);

  const m1Node = graph.nodes.find((n) => n.sha === "m1");
  assert.deepEqual(m1Node?.fanOutPaths, ["/repo/wt-b1"]);
});

test("buildWorktreeNodePrompt formats a structured prompt with topology and WIP", () => {
  const item = {
    path: "/home/alice/pi-web-reader-worktrees/sidebar-button",
    branch: "fix/sidebar-button",
    isMain: false,
    label: "fix/sidebar-button",
    sourceKind: "worktree",
    head: "c80f669cbd8f72d7f26c34d1c5f94b3b5400a237",
    shortHead: "c80f669c",
    headSubject: "fix: align sidebar worktree button",
    headAuthor: "Dev",
    headTimestamp: 1727670000,
    headIsoDate: "2026-09-30T04:00:00Z",
    baseCommit: "b0e576071fd13a3d16ffeb46a7e830686826d17c",
    shortBase: "b0e57607",
    baseSubject: "fix(reader): clear archive errors",
    baseTimestamp: 1727660000,
    baseIsoDate: "2026-09-29T18:00:00Z",
    mergedIntoCommit: "19228fbe3b46c1ce59645e8de23adad93094e38a",
    shortMergedInto: "19228fbe",
    mergedIntoSubject: "Merge integrate/reader-consolidate",
    mergedIntoTimestamp: 1727672000,
    mergedIntoIsoDate: "2026-09-30T05:00:00Z",
    ahead: 1,
    behind: 5,
    status: "merged",
    laneColorIndex: 2,
    dirtySummary: {
      state: "dirty",
      hasUncommitted: true,
      dirtyCount: 2,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 0,
      ignoredCount: 0,
    },
  };

  const prompt = buildWorktreeNodePrompt(item);
  assert.ok(prompt.includes("请在以下 Git Worktree 节点基础上继续开发修改："));
  assert.ok(prompt.includes("- Worktree 路径：/home/alice/pi-web-reader-worktrees/sidebar-button"));
  assert.ok(prompt.includes("- 分支 / 标识：fix/sidebar-button"));
  assert.ok(prompt.includes("- 当前节点 (HEAD)：c80f669c · fix: align sidebar worktree button"));
  assert.ok(prompt.includes("- 基线节点 (Base)：b0e57607 · fix(reader): clear archive errors（分支拓扑差异 1；起点距主线 5 个提交；这是工作树拓扑估算：距离为所选基线到当前主线的 first-parent 距离，已合入时的差异值可能只是基线标记，不是 upstream 对称差集）"));
  assert.ok(prompt.includes("- 合并节点：已合入主线 19228fbe · Merge integrate/reader-consolidate"));
  assert.ok(prompt.includes("- 工作区 WIP：2 个未提交条目（已暂存 1、未暂存 1、未跟踪 0）"));
  assert.ok(prompt.includes("本次任务需求："));
});

test("batch dirty summaries attach to graph rows without exposing paths", () => {
  const graph = computeWorktreeGraphFromDag(
    "/repo",
    [{ path: "/repo", branch: "main", head: "m1", isMain: true }],
    ["m1"],
    new Map([["m1", { timestamp: 1, isoDate: "2026-10-08T00:00:00Z", author: "Dev", subject: "main" }]]),
  );
  const projected = attachDirtySummaryProjection(graph, new Map([
    ["/repo", {
      state: "dirty",
      hasUncommitted: true,
      dirtyCount: 2,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 0,
      ignoredCount: 3,
    }],
  ]));
  assert.equal(projected.counts.wip, 1);
  assert.deepEqual(projected.worktrees[0]?.dirtySummary, {
    state: "dirty",
    hasUncommitted: true,
    dirtyCount: 2,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 0,
    ignoredCount: 3,
  });
  assert.doesNotMatch(JSON.stringify(projected), /secret|token|password|\.env/i);
});

test("dirty projection stays independent across main, active, merged, and at-base rows", () => {
  const graph = computeWorktreeGraphFromDag(
    "/repo",
    [
      { path: "/repo/main", branch: "main", head: "m3", isMain: true },
      { path: "/repo/active", branch: "feature/active", head: "a1", isMain: false },
      { path: "/repo/merged", branch: "feature/merged", head: "b1", isMain: false },
      { path: "/repo/base", branch: "feature/base", head: "m2", isMain: false },
    ],
    ["m3 m2 b1", "b1 m1", "m2 m1", "m1", "a1 m2"],
    new Map([
      ["m3", { timestamp: 3, isoDate: "2026-10-08T00:00:03Z", author: "Dev", subject: "main" }],
      ["m2", { timestamp: 2, isoDate: "2026-10-08T00:00:02Z", author: "Dev", subject: "base" }],
      ["m1", { timestamp: 1, isoDate: "2026-10-08T00:00:01Z", author: "Dev", subject: "initial" }],
      ["b1", { timestamp: 2, isoDate: "2026-10-08T00:00:02Z", author: "Dev", subject: "merged feature" }],
      ["a1", { timestamp: 4, isoDate: "2026-10-08T00:00:04Z", author: "Dev", subject: "active" }],
    ]),
  );
  const dirty = (count) => ({
    state: "dirty",
    hasUncommitted: true,
    dirtyCount: count,
    stagedCount: 0,
    unstagedCount: count,
    untrackedCount: 0,
    ignoredCount: 0,
  });
  const projected = attachDirtySummaryProjection(graph, new Map([
    ["/repo/main", dirty(1)],
    ["/repo/active", dirty(2)],
    ["/repo/merged", dirty(3)],
    ["/repo/base", dirty(4)],
  ]));
  assert.deepEqual(
    projected.worktrees.map((row) => [row.status, row.dirtySummary?.dirtyCount]),
    [["main", 1], ["active", 2], ["merged", 3], ["at_base", 4]],
  );
  assert.equal(projected.counts.wip, 4);
});

test("computeWorktreeGraphFromDag keeps an unknown active head visible", () => {
  const graph = computeWorktreeGraphFromDag(
    "/repo/main",
    [
      { path: "/repo/main", branch: "main", head: "m1", isMain: true },
      { path: "/repo/unknown", branch: "feature/unknown", head: "u1", isMain: false },
    ],
    ["m1", "malformed", ""],
    new Map([["m1", { timestamp: 10, isoDate: "2026-09-30T00:00:00Z", author: "Dev", subject: "main" }]]),
  );

  const item = graph.worktrees.find((worktree) => worktree.path === "/repo/unknown");
  assert.ok(item);
  assert.equal(item.status, "active");
  assert.equal(item.ahead, 1);
  assert.equal(item.baseCommit, "m1");
});

test("a checkout whose HEAD sits on the main first-parent spine is at base", () => {
  const graph = computeWorktreeGraphFromDag(
    "/repo/main",
    [
      { path: "/repo/main", branch: "main", head: "m2", isMain: true },
      { path: "/repo/fresh", branch: "feature/fresh", head: "m1", isMain: false },
    ],
    ["m2 m1", "m1"],
    new Map([
      ["m2", { timestamp: 20, isoDate: "2026-09-30T00:20:00Z", author: "Dev", subject: "main" }],
      ["m1", { timestamp: 10, isoDate: "2026-09-30T00:10:00Z", author: "Dev", subject: "base" }],
    ]),
  );
  const item = graph.worktrees.find((w) => w.path === "/repo/fresh");
  assert.equal(item?.status, "at_base");
  assert.equal(item?.baseCommit, "m1");
  assert.equal(item?.behind, 1);
});
