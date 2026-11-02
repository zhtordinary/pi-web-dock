export type WorktreeSourceKind =
  | "main"
  | "integration"
  | "task"
  | "devspace"
  | "worktree";

export type WorktreeNodeStatus =
  | "main"
  | "active"
  | "merged"
  // Current HEAD has no commit increment beyond the recorded fork base.
  | "at_base";

export type WorktreeDirtyState = "clean" | "dirty" | "unavailable";

/** Read-only working-tree counts collected alongside a graph request. */
export interface WorktreeDirtySummary {
  state: WorktreeDirtyState;
  hasUncommitted: boolean;
  dirtyCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  ignoredCount: number;
}

export interface WorktreeGraphItem {
  path: string;
  branch: string | null;
  isMain: boolean;
  label: string;
  sourceKind: WorktreeSourceKind;
  head: string;
  shortHead: string;
  headSubject: string;
  headAuthor: string;
  headTimestamp: number;
  headIsoDate: string;
  baseCommit: string;
  shortBase: string;
  baseSubject: string;
  baseTimestamp: number;
  baseIsoDate: string;
  mergedIntoCommit: string | null;
  shortMergedInto: string | null;
  mergedIntoSubject: string | null;
  mergedIntoTimestamp: number | null;
  mergedIntoIsoDate: string | null;
  ahead: number;
  behind: number;
  status: WorktreeNodeStatus;
  laneColorIndex: number;
  /** Batch status projection; file names are intentionally never included. */
  dirtySummary?: WorktreeDirtySummary;
}

/** Focus view: the main and current checkouts, unmerged work, and uncommitted or unreadable state. */
export function worktreeNeedsAttention(worktree: WorktreeGraphItem, currentPath?: string | null): boolean {
  if (worktree.isMain || worktree.path === currentPath) return true;
  if (worktree.status === "active") return true;
  return Boolean(worktree.dirtySummary?.hasUncommitted) || worktree.dirtySummary?.state === "unavailable";
}

export interface WorktreeTimelineNode {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  timestamp: number;
  isoDate: string;
  spineIndex: number;
  isMainHead: boolean;
  mainPaths: string[];
  fanOutPaths: string[];
  mergedPaths: string[];
  atBasePaths: string[];
}

export interface WorktreeGraph {
  projectRoot: string;
  projectKey?: string;
  targetBranch: string | null;
  mainHead: string;
  shortMainHead: string;
  mainSubject: string;
  totalWorktrees: number;
  counts: {
    main: number;
    active: number;
    merged: number;
    atBase: number;
    /** Worktrees with one or more non-ignored uncommitted entries. */
    wip?: number;
  };
  /**
   * `behind` is first-parent distance from the selected topology base to main HEAD.
   * `ahead` counts reachable commits outside the main first-parent spine; for an
   * on-spine/merged head it can be a minimum topology marker when a recorded
   * base differs, so neither value is an upstream symmetric difference.
   */
  deltaBasis?: "topology-fork-base-first-parent";
  nodes: WorktreeTimelineNode[];
  worktrees: WorktreeGraphItem[];
  /** GitHub repository info when project has a github.com remote; null otherwise. */
  githubRepository?: { owner: string; repo: string } | null;
  /** Canonical GitHub repository URL (https://github.com/owner/repo). */
  githubUrl?: string | null;
}

export type WorktreeInspectionCommitMode = "head-history" | "since-base";

export interface WorktreeInspection {
  path: string;
  dirtyCount: number;
  dirtyFiles: Array<{ status: string; path: string; mtimeMs?: number }>;
  commitMode: WorktreeInspectionCommitMode;
  commits: Array<{
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    isoDate: string;
  }>;
}

export interface CommitMetaEntry {
  timestamp: number;
  isoDate: string;
  author: string;
  subject: string;
}

export interface RawWorktreeRecord {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
}

/** Join batch working-tree status without exposing any status paths. */
export function attachDirtySummaryProjection(
  graph: WorktreeGraph,
  summaries: ReadonlyMap<string, WorktreeDirtySummary>,
): WorktreeGraph {
  let wip = 0;
  const worktrees = graph.worktrees.map((item) => {
    const dirtySummary = summaries.get(item.path);
    if (dirtySummary?.hasUncommitted) wip += 1;
    return dirtySummary ? { ...item, dirtySummary } : item;
  });
  return {
    ...graph,
    counts: { ...graph.counts, wip },
    worktrees,
  };
}

export const WORKTREE_LANE_COLORS = [
  "#10b981", // emerald
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f97316", // orange
  "#14b8a6", // teal
] as const;

export function worktreeLaneColor(index: number): string {
  const safe = Math.abs(Math.trunc(index)) % WORKTREE_LANE_COLORS.length;
  return WORKTREE_LANE_COLORS[safe];
}

function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pathSegments(filePath: string): string[] {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function classifyWorktreeSource(
  worktreePath: string,
  branch: string | null,
  isMain: boolean,
): WorktreeSourceKind {
  if (isMain) return "main";
  const normalized = worktreePath.replace(/\\/g, "/");
  if (
    normalized.includes("/.devspace/worktrees/")
    || normalized.includes("/pi-plan-execute/")
  ) {
    return "devspace";
  }
  if (
    normalized.includes("-integration")
    || normalized.includes("/integrations/")
    || branch?.startsWith("integrate/")
  ) {
    return "integration";
  }
  if (
    normalized.includes("-tasks/")
    || branch?.startsWith("task/")
  ) {
    return "task";
  }
  return "worktree";
}

export function deriveWorktreeLabel(
  worktreePath: string,
  branch: string | null,
  isMain: boolean,
): string {
  if (isMain) {
    return branch || pathSegments(worktreePath).at(-1) || worktreePath;
  }
  if (branch) return branch;
  const segs = pathSegments(worktreePath);
  const last = segs.at(-1) ?? worktreePath;
  if (last === "worktree" && segs.length >= 2) {
    return segs.at(-2)!.replace(/^\.pi-collab-/, "");
  }
  return last;
}

export function buildWorktreeNodePrompt(wt: WorktreeGraphItem): string {
  const lines = [
    "请在以下 Git Worktree 节点基础上继续开发修改：",
    `- Worktree 路径：${wt.path}`,
    `- 分支 / 标识：${wt.branch ?? `${wt.label} (detached HEAD)`}`,
    `- 当前节点 (HEAD)：${wt.shortHead}${wt.headSubject ? ` · ${wt.headSubject}` : ""}`,
    `- 基线节点 (Base)：${wt.shortBase}${wt.baseSubject ? ` · ${wt.baseSubject}` : ""}（分支拓扑差异 ${wt.ahead}；起点距主线 ${wt.behind} 个提交；这是工作树拓扑估算：距离为所选基线到当前主线的 first-parent 距离，已合入时的差异值可能只是基线标记，不是 upstream 对称差集）`,
  ];
  if (wt.shortMergedInto) {
    lines.push(
      `- 合并节点：已合入主线 ${wt.shortMergedInto}${wt.mergedIntoSubject ? ` · ${wt.mergedIntoSubject}` : ""}`,
    );
  }
  if (wt.dirtySummary) {
    if (wt.dirtySummary.state === "unavailable") {
      lines.push("- 工作区 WIP：当前无法读取未提交状态，请在继续修改前重新检查");
    } else if (wt.dirtySummary.hasUncommitted) {
      lines.push(
        `- 工作区 WIP：${wt.dirtySummary.dirtyCount} 个未提交条目（已暂存 ${wt.dirtySummary.stagedCount}、未暂存 ${wt.dirtySummary.unstagedCount}、未跟踪 ${wt.dirtySummary.untrackedCount}）`,
      );
    }
  }
  lines.push("", "本次任务需求：", "");
  return lines.join("\n");
}

export function computeWorktreeGraphFromDag(
  projectRoot: string,
  rawWorktrees: readonly RawWorktreeRecord[],
  dagLines: readonly string[],
  commitMeta: ReadonlyMap<string, CommitMetaEntry>,
): WorktreeGraph {
  const mainWt = rawWorktrees.find((w) => w.isMain) ?? rawWorktrees[0];
  const mainHead = mainWt?.head ?? "";
  const targetBranch = mainWt?.branch ?? null;

  const parents = new Map<string, string[]>();
  for (const rawLine of dagLines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0]) {
      parents.set(parts[0], parts.slice(1));
    }
  }

  // 1. Reachable from mainHead
  const mainAnc = new Set<string>();
  if (mainHead) {
    const stack = [mainHead];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (mainAnc.has(cur)) continue;
      mainAnc.add(cur);
      for (const p of parents.get(cur) ?? []) {
        if (!mainAnc.has(p)) stack.push(p);
      }
    }
  }

  // 2. First-parent spine from mainHead (0 = newest = mainHead)
  const spine: string[] = [];
  const seenSpine = new Set<string>();
  const spineIndex = new Map<string, number>();
  let cursor: string | undefined = mainHead;
  while (cursor && !seenSpine.has(cursor)) {
    seenSpine.add(cursor);
    spineIndex.set(cursor, spine.length);
    spine.push(cursor);
    const ps = parents.get(cursor);
    cursor = ps && ps.length > 0 ? ps[0] : undefined;
  }

  // 3. Walk spine from oldest to newest so each side-branch commit is claimed
  //    by the first (oldest) spine commit that merged it in.
  const absorbedBy = new Map<string, string>();
  for (let i = spine.length - 1; i >= 0; i -= 1) {
    const s = spine[i];
    const stack = [s];
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (absorbedBy.has(x)) continue;
      absorbedBy.set(x, s);
      for (const p of parents.get(x) ?? []) {
        if (!absorbedBy.has(p)) stack.push(p);
      }
    }
  }

  // 4. Find spine base and ahead count for any commit h
  const findSpineBase = (head: string): { base: string; ahead: number } => {
    if (!head || seenSpine.has(head)) {
      return { base: head || mainHead, ahead: 0 };
    }
    const anc = new Set<string>();
    const boundary = new Set<string>();
    const stack = [head];
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (seenSpine.has(x)) {
        boundary.add(x);
        continue;
      }
      if (anc.has(x)) continue;
      anc.add(x);
      for (const p of parents.get(x) ?? []) {
        stack.push(p);
      }
    }
    let bestBase = mainHead;
    let bestIdx = Number.MAX_SAFE_INTEGER;
    for (const b of boundary) {
      const idx = spineIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (idx < bestIdx) {
        bestIdx = idx;
        bestBase = b;
      }
    }
    return { base: bestBase, ahead: anc.size };
  };

  // Assign lane colors consistently per base commit so sibling worktrees fanning
  // out from the same base share a coherent lane color (Kagi WipAnchor rule).
  const baseColorMap = new Map<string, number>();
  let nextColorIdx = 0;
  const getBaseColor = (baseSha: string): number => {
    const existing = baseColorMap.get(baseSha);
    if (existing !== undefined) return existing;
    const assigned = nextColorIdx % WORKTREE_LANE_COLORS.length;
    nextColorIdx += 1;
    baseColorMap.set(baseSha, assigned);
    return assigned;
  };

  const counts = { main: 0, active: 0, merged: 0, atBase: 0 };
  const nodeBuckets = new Map<
    string,
    { mainPaths: string[]; fanOutPaths: string[]; mergedPaths: string[]; atBasePaths: string[] }
  >();
  const ensureBucket = (sha: string) => {
    let b = nodeBuckets.get(sha);
    if (!b) {
      b = { mainPaths: [], fanOutPaths: [], mergedPaths: [], atBasePaths: [] };
      nodeBuckets.set(sha, b);
    }
    return b;
  };
  if (mainHead) ensureBucket(mainHead);

  const items: WorktreeGraphItem[] = rawWorktrees.map((wt) => {
    const head = wt.head || mainHead;
    let status: WorktreeNodeStatus;
    let baseCommit: string;
    let ahead: number;
    let mergedIntoCommit: string | null = null;

    if (wt.isMain) {
      status = "main";
      baseCommit = head;
      ahead = 0;
      counts.main += 1;
      if (head) {
        ensureBucket(head).mainPaths.push(wt.path);
      }
    } else if (!mainAnc.has(head)) {
      status = "active";
      const found = findSpineBase(head);
      baseCommit = found.base;
      ahead = Math.max(1, found.ahead);
      counts.active += 1;
    } else {
      const found = findSpineBase(head);
      baseCommit = found.base;
      const absorbed = absorbedBy.get(head) ?? head;
      ahead = Math.max(found.ahead, baseCommit !== head ? 1 : 0);
      if (baseCommit !== head || ahead > 0) {
        status = "merged";
        mergedIntoCommit = absorbed;
        counts.merged += 1;
      } else {
        status = "at_base";
        mergedIntoCommit = null;
        counts.atBase += 1;
      }
    }

    const behind = spineIndex.get(baseCommit) ?? 0;
    const headInfo = commitMeta.get(head);
    const baseInfo = commitMeta.get(baseCommit);
    const mergedInfo = mergedIntoCommit ? commitMeta.get(mergedIntoCommit) : undefined;
    const sourceKind = classifyWorktreeSource(wt.path, wt.branch, wt.isMain);
    const label = deriveWorktreeLabel(wt.path, wt.branch, wt.isMain);
    const laneColorIndex = wt.isMain ? 0 : getBaseColor(baseCommit || wt.path);

    if (!wt.isMain && baseCommit) {
      const bucket = ensureBucket(baseCommit);
      if (status === "at_base") {
        bucket.atBasePaths.push(wt.path);
      } else {
        bucket.fanOutPaths.push(wt.path);
      }
    }
    if (status === "merged" && mergedIntoCommit) {
      ensureBucket(mergedIntoCommit).mergedPaths.push(wt.path);
    }

    return {
      path: wt.path,
      branch: wt.branch,
      isMain: wt.isMain,
      label,
      sourceKind,
      head,
      shortHead: head.slice(0, 8),
      headSubject: headInfo?.subject || "",
      headAuthor: headInfo?.author || "",
      headTimestamp: headInfo?.timestamp ?? 0,
      headIsoDate: headInfo?.isoDate || "",
      baseCommit,
      shortBase: baseCommit.slice(0, 8),
      baseSubject: baseInfo?.subject || "",
      baseTimestamp: baseInfo?.timestamp ?? 0,
      baseIsoDate: baseInfo?.isoDate || "",
      mergedIntoCommit,
      shortMergedInto: mergedIntoCommit ? mergedIntoCommit.slice(0, 8) : null,
      mergedIntoSubject: mergedInfo?.subject ?? null,
      mergedIntoTimestamp: mergedInfo?.timestamp ?? null,
      mergedIntoIsoDate: mergedInfo?.isoDate ?? null,
      ahead,
      behind,
      status,
      laneColorIndex: Number.isFinite(laneColorIndex) ? laneColorIndex : stableHash(wt.path) % WORKTREE_LANE_COLORS.length,
    };
  });

  // Sort worktrees within each bucket: active first (newest headTimestamp first), then merged, then at_base
  const itemByPath = new Map(items.map((it) => [it.path, it]));
  const sortPaths = (paths: string[]) =>
    paths.sort((a, b) => {
      const wa = itemByPath.get(a);
      const wb = itemByPath.get(b);
      if (!wa || !wb) return a.localeCompare(b);
      const order = { main: 0, active: 1, merged: 2, at_base: 3 };
      if (order[wa.status] !== order[wb.status]) return order[wa.status] - order[wb.status];
      if (wb.headTimestamp !== wa.headTimestamp) return wb.headTimestamp - wa.headTimestamp;
      return wa.label.localeCompare(wb.label);
    });

  const nodes: WorktreeTimelineNode[] = [...nodeBuckets.entries()]
    .map(([sha, bucket]) => {
      sortPaths(bucket.mainPaths);
      sortPaths(bucket.fanOutPaths);
      sortPaths(bucket.mergedPaths);
      sortPaths(bucket.atBasePaths);
      const info = commitMeta.get(sha);
      return {
        sha,
        shortSha: sha.slice(0, 8),
        subject: info?.subject || "",
        author: info?.author || "",
        timestamp: info?.timestamp ?? 0,
        isoDate: info?.isoDate || "",
        spineIndex: spineIndex.get(sha) ?? 999_999,
        isMainHead: sha === mainHead,
        mainPaths: bucket.mainPaths,
        fanOutPaths: bucket.fanOutPaths,
        mergedPaths: bucket.mergedPaths,
        atBasePaths: bucket.atBasePaths,
      };
    })
    .sort((a, b) => {
      if (a.spineIndex !== b.spineIndex) return a.spineIndex - b.spineIndex;
      return b.timestamp - a.timestamp;
    });

  const mainInfo = commitMeta.get(mainHead);
  return {
    projectRoot,
    targetBranch,
    mainHead,
    shortMainHead: mainHead.slice(0, 8),
    mainSubject: mainInfo?.subject || "",
    totalWorktrees: items.length,
    counts,
    deltaBasis: "topology-fork-base-first-parent",
    nodes,
    worktrees: items,
  };
}
