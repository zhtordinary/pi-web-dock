import { isAbsolute, normalize } from "node:path";
import type { SessionEntry, SessionInfo } from "./types";

export const WORKTREE_BINDING_CUSTOM_TYPE = "pi-web:worktree-binding";

export type WorktreeBindingAction = "bind" | "release";
export type WorktreeBindingRelation = "creator" | "task-root";

export interface WorktreeBindingDraft {
  projectRoot: string;
  worktreePath: string;
  relation: WorktreeBindingRelation;
}

export interface WorktreeBindingData {
  version: 1;
  action: WorktreeBindingAction;
  relation: WorktreeBindingRelation;
  projectRoot: string;
  worktreePath: string;
}

export interface WorktreeBindingRecord {
  worktreePath: string;
  sessionId: string;
  relation: WorktreeBindingRelation;
  createdAt: string;
  sessionName?: string;
}

interface WorktreeBindingSessionManager {
  getEntries(): readonly unknown[];
  appendCustomEntry(customType: string, data: unknown): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !isAbsolute(value)) return undefined;
  return normalize(value);
}

function parseBinding(value: unknown): WorktreeBindingData | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (value.action !== "bind" && value.action !== "release") return undefined;
  if (value.relation !== "creator" && value.relation !== "task-root") return undefined;
  const projectRoot = normalizeAbsolutePath(value.projectRoot);
  const worktreePath = normalizeAbsolutePath(value.worktreePath);
  if (!projectRoot || !worktreePath) return undefined;
  return {
    version: 1,
    action: value.action,
    relation: value.relation,
    projectRoot,
    worktreePath,
  };
}

function bindingKey(relation: WorktreeBindingRelation, worktreePath: string): string {
  return `${relation}:${normalize(worktreePath)}`;
}

function isActiveBinding(
  entries: readonly unknown[],
  binding: WorktreeBindingData,
): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WORKTREE_BINDING_CUSTOM_TYPE) continue;
    const candidate = parseBinding(entry.data);
    if (!candidate || candidate.projectRoot !== binding.projectRoot
      || candidate.relation !== binding.relation || candidate.worktreePath !== binding.worktreePath) continue;
    return candidate.action === "bind";
  }
  return false;
}

/**
 * Append one idempotent, structured worktree/session binding to a native
 * session transcript. The session id is implicit in the transcript owner.
 */
export function appendWorktreeBinding(
  manager: WorktreeBindingSessionManager,
  input: Omit<WorktreeBindingData, "version" | "action"> & { action?: WorktreeBindingAction },
): boolean {
  const data: WorktreeBindingData = {
    version: 1,
    action: input.action ?? "bind",
    relation: input.relation,
    projectRoot: normalize(input.projectRoot),
    worktreePath: normalize(input.worktreePath),
  };
  if (!isAbsolute(data.projectRoot) || !isAbsolute(data.worktreePath)) {
    throw new Error("Worktree binding paths must be absolute");
  }
  if (data.action === "bind" && isActiveBinding(manager.getEntries(), data)) return false;
  manager.appendCustomEntry(WORKTREE_BINDING_CUSTOM_TYPE, data);
  return true;
}

/** A null path set retains bounded candidates for projection against later worktree lists. */
export function createWorktreeBindingCollector(
  session: Pick<SessionInfo, "id" | "name">,
  projectRoot: string,
  worktreePaths: readonly string[] | null,
) {
  const normalizedProjectRoot = normalizeAbsolutePath(projectRoot);
  const registeredPaths = worktreePaths && new Set(
    worktreePaths.map(normalizeAbsolutePath).filter((path): path is string => Boolean(path)),
  );
  const active = new Map<string, { binding: WorktreeBindingData; createdAt: string }>();
  return {
    add(entry: SessionEntry) {
      if (entry.type !== "custom" || entry.customType !== WORKTREE_BINDING_CUSTOM_TYPE) return;
      const binding = parseBinding(entry.data);
      if (!binding || binding.projectRoot !== normalizedProjectRoot || (registeredPaths && !registeredPaths.has(binding.worktreePath))) return;
      const key = bindingKey(binding.relation, binding.worktreePath);
      if (binding.action === "release") active.delete(key);
      else {
        if (!registeredPaths && !active.has(key) && active.size >= 4096) throw new Error("Too many worktree binding candidates");
        active.set(key, { binding, createdAt: entry.timestamp });
      }
    },
    records: (): WorktreeBindingRecord[] => [...active.values()].map(({ binding, createdAt }) => ({
      worktreePath: binding.worktreePath,
      sessionId: session.id,
      relation: binding.relation,
      createdAt,
      ...(session.name ? { sessionName: session.name } : {}),
    })),
  };
}

export function findWorktreeBindingRecords(
  entries: readonly SessionEntry[],
  session: Pick<SessionInfo, "id" | "name">,
  projectRoot: string,
  worktreePaths: readonly string[],
): WorktreeBindingRecord[] {
  const collector = createWorktreeBindingCollector(session, projectRoot, worktreePaths);
  for (const entry of entries) collector.add(entry);
  return collector.records();
}
