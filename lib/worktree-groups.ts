import type { SessionInfo } from "./types";

// Client-safe project identity for sessions that predate the server-set
// `projectKey`. This module is rendered by SessionSidebar in the browser and
// must not import `node:*`; the server value stays authoritative.
// ponytail: separator/trailing-slash normalization only. Add dot-segment
// resolution here if a Windows client ever needs it client-side.
function clientPathIdentity(value: string): string {
  if (!value) return value;
  const slashed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return slashed || "/";
}

/** A linked checkout as reported by `git worktree list`. */
export interface LinkedWorktree {
  path: string;
  branch: string | null;
}

export type WorktreeSessionGroupKind = "project" | "main" | "worktree";

export interface WorktreeSessionGroup {
  key: string;
  kind: WorktreeSessionGroupKind;
  label: string;
  path: string;
  branch?: string;
  items: SessionInfo[];
}

function sessionProjectIdentity(session: SessionInfo): string {
  return session.projectKey ?? clientPathIdentity(session.projectRoot ?? session.cwd);
}

function scopePrefix(projectKey: string, deviceId?: string): string {
  return `${deviceId ? `${deviceId}:` : ""}worktree:${projectKey}:`;
}

export function worktreeGroupKey(projectKey: string, path: string, deviceId?: string): string {
  return `${scopePrefix(projectKey, deviceId)}${clientPathIdentity(path)}`;
}

function identityFor(session: SessionInfo, kind: WorktreeSessionGroupKind, deviceId?: string): string {
  const project = sessionProjectIdentity(session);
  if (kind === "worktree") return worktreeGroupKey(project, session.cwd, deviceId);
  const prefix = deviceId ? `${deviceId}:` : "";
  if (kind === "main") return `${prefix}main:${project}`;
  return `${prefix}project:${project}:${clientPathIdentity(session.cwd)}`;
}

/**
 * Add rows for linked worktrees that have no sessions yet, so a session can be
 * started there. A checkout already represented by a session group (same path,
 * or the same branch within the project and device) is not repeated.
 */
export function addEmptyWorktreeGroups(
  groups: WorktreeSessionGroup[],
  worktrees: readonly LinkedWorktree[],
  projectKey: string,
  deviceId?: string,
): WorktreeSessionGroup[] {
  const prefix = scopePrefix(projectKey, deviceId);
  for (const worktree of worktrees) {
    const key = worktreeGroupKey(projectKey, worktree.path, deviceId);
    const represented = groups.some((group) => group.key === key
      || (worktree.branch !== null && group.kind === "worktree" && group.branch === worktree.branch && group.key.startsWith(prefix)));
    if (represented) continue;
    groups.push({
      key,
      kind: "worktree",
      label: worktree.branch ?? worktree.path,
      path: worktree.path,
      ...(worktree.branch ? { branch: worktree.branch } : {}),
      items: [],
    });
  }
  return groups;
}

/**
 * Group only the sessions supplied by the caller. Each checkout keeps its own
 * group; project and device stay part of the key.
 */
export function groupSessionsByWorktree<T>(
  items: readonly T[],
  sessionOf: (item: T) => SessionInfo,
  deviceOf?: (item: T) => string,
): WorktreeSessionGroup[] {
  const groups = new Map<string, WorktreeSessionGroup>();

  for (const item of items) {
    const session = sessionOf(item);
    const branch = session.worktreeBranch ?? session.branch ?? undefined;
    const kind: WorktreeSessionGroupKind = session.isGit === true
      ? session.isWorktree === true ? "worktree" : "main"
      : "project";
    const key = identityFor(session, kind, deviceOf?.(item));
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        kind,
        label: kind === "main" ? (branch ?? "main") : kind === "worktree" ? (branch ?? session.cwd) : session.cwd,
        path: session.cwd,
        ...(branch ? { branch } : {}),
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(session);
  }

  return sortWorktreeSessionGroups([...groups.values()]);
}

export function sortWorktreeSessionGroups(groups: WorktreeSessionGroup[]): WorktreeSessionGroup[] {
  const rank: Record<WorktreeSessionGroupKind, number> = { main: 0, project: 1, worktree: 2 };
  return [...groups].sort((left, right) => {
    const rankDelta = rank[left.kind] - rank[right.kind];
    if (rankDelta !== 0) return rankDelta;
    return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
  });
}
