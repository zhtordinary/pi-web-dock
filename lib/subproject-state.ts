import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { getPiSessionRoots } from "./session-archive";

export const SUBPROJECT_SCHEMA_VERSION = 1 as const;

export type SubprojectSortMode = "alpha" | "inherit" | "custom";

export interface SubprojectDefinition {
  id: string;
  projectKey: string;
  label: string;
  /** Display-only visibility preference; absent legacy values are visible. */
  hidden?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubprojectAssignment {
  sessionId: string;
  projectKey: string;
  subprojectId: string;
}

export interface SubprojectSortSetting {
  projectKey: string;
  mode: SubprojectSortMode;
  order: string[];
  /** Project-scoped policy: hide subprojects with no sessions in the active time range. */
  autoHideEmptySubprojects?: boolean;
}

export interface SubprojectState {
  schemaVersion: typeof SUBPROJECT_SCHEMA_VERSION;
  subprojects: SubprojectDefinition[];
  assignments: SubprojectAssignment[];
  /** Additive v1 field; absent in older sidecars and treated as custom order. */
  sortSettings?: SubprojectSortSetting[];
}

export type SubprojectErrorCode =
  | "subproject_required"
  | "subproject_label_conflict"
  | "subproject_not_found"
  | "subproject_project_mismatch"
  | "subproject_state_read_only";

export class SubprojectDomainError extends Error {
  readonly code: SubprojectErrorCode;

  constructor(code: SubprojectErrorCode, message: string) {
    super(message);
    this.name = "SubprojectDomainError";
    this.code = code;
  }
}

function stateFile(): string {
  return process.env.PI_WEB_SUBPROJECTS_FILE
    ?? join(process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? ".", ".config"), "pi-web-reader", "subprojects.json");
}

declare global {
  var __piSubprojectStateRuntimes: Map<string, { loaded: boolean; state: SubprojectState; orphanScanAttempted: boolean }> | undefined;
}

function runtime(file = stateFile()): { loaded: boolean; state: SubprojectState; orphanScanAttempted: boolean } {
  globalThis.__piSubprojectStateRuntimes ??= new Map();
  let value = globalThis.__piSubprojectStateRuntimes.get(file);
  if (!value) {
    value = { loaded: false, state: emptyState(), orphanScanAttempted: false };
    globalThis.__piSubprojectStateRuntimes.set(file, value);
  }
  return value;
}

function emptyState(): SubprojectState {
  return { schemaVersion: SUBPROJECT_SCHEMA_VERSION, subprojects: [], assignments: [] };
}

function cloneState(state: SubprojectState): SubprojectState {
  return {
    schemaVersion: SUBPROJECT_SCHEMA_VERSION,
    subprojects: state.subprojects.map((item) => ({ ...item })),
    assignments: state.assignments.map((item) => ({ ...item })),
    ...(state.sortSettings ? { sortSettings: state.sortSettings.map((item) => ({ ...item, order: [...item.order] })) } : {}),
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ponytail: one process-startup directory scan; use a persistent session index if scale makes this measurable.

function sessionIdentityFromFile(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, length).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    if (header.type === "session" && typeof header.id === "string" && header.id.trim()) return header.id;
  } catch { /* An unreadable header cannot prove any assignment is orphaned. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

function addSessionFiles(directory: string, ids: Set<string>): boolean {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    const filePath = join(directory, entry.name);
    if (entry.isFile()) {
      const id = sessionIdentityFromFile(filePath);
      if (!id) return false;
      ids.add(id);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      if (!statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const id = sessionIdentityFromFile(filePath);
    if (!id) return false;
    ids.add(id);
  }
  return true;
}

function scanSessionRoot(root: string): { ids: Set<string>; complete: boolean } {
  const ids = new Set<string>();
  // A missing lifecycle root is an unavailable scan, not an empty root. Treating
  // it as complete would make the orphan cleanup delete assignments merely
  // because one Pi lifecycle directory has not been mounted yet.
  if (!existsSync(root)) return { ids, complete: false };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { ids, complete: false };
  }
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isFile()) {
      if (!entry.name.endsWith(".jsonl")) continue;
      const id = sessionIdentityFromFile(entryPath);
      if (!id) return { ids, complete: false };
      ids.add(id);
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.isSymbolicLink()) {
      try {
        if (!statSync(entryPath).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    if (!addSessionFiles(entryPath, ids)) return { ids, complete: false };
  }
  return { ids, complete: true };
}

function sessionIdsOnDisk(): Set<string> | undefined {
  const roots = getPiSessionRoots();
  const ids = new Set<string>();
  for (const root of [roots.sessionsDir, roots.archivedSessionsDir, roots.deletedSessionsDir]) {
    const scan = scanSessionRoot(root);
    if (!scan.complete) return undefined;
    for (const id of scan.ids) ids.add(id);
  }
  return ids;
}

/**
 * Session APIs historically exposed both workspace-relative and absolute path
 * keys. Store one canonical path key so old sidecars keep working after API
 * callers switch to the absolute session identity.
 */
export function canonicalProjectKey(input: string): string {
  const key = input.trim();
  const workspaceRoot = process.env.PI_WEB_WORKSPACE_ROOT || process.env.HOME || ".";
  if (key.startsWith("path:")) return `path:${resolve(workspaceRoot, key.slice("path:".length))}`;
  // SessionInfo historically exposed a bare absolute path while subproject
  // state used the tagged `path:` form.
  if (isAbsolute(key)) return `path:${resolve(key)}`;
  return key;
}

export function projectKeysEqual(left: string, right: string): boolean {
  return canonicalProjectKey(left) === canonicalProjectKey(right);
}

function canonicalizeState(state: SubprojectState): SubprojectState {
  return {
    schemaVersion: SUBPROJECT_SCHEMA_VERSION,
    subprojects: state.subprojects.map((item) => ({ ...item, projectKey: canonicalProjectKey(item.projectKey) })),
    assignments: state.assignments.map((item) => ({ ...item, projectKey: canonicalProjectKey(item.projectKey) })),
    ...(state.sortSettings ? {
      sortSettings: state.sortSettings.map((item) => ({ ...item, projectKey: canonicalProjectKey(item.projectKey), order: [...item.order] })),
    } : {}),
  };
}

function validDefinition(value: unknown): value is SubprojectDefinition {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SubprojectDefinition>;
  return nonEmpty(item.id) && nonEmpty(item.projectKey) && nonEmpty(item.label)
    && nonEmpty(item.createdAt) && nonEmpty(item.updatedAt)
    && (item.hidden === undefined || typeof item.hidden === "boolean");
}

function validAssignment(value: unknown): value is SubprojectAssignment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SubprojectAssignment>;
  return nonEmpty(item.sessionId) && nonEmpty(item.projectKey) && nonEmpty(item.subprojectId);
}

function validSortSetting(value: unknown): value is SubprojectSortSetting {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SubprojectSortSetting>;
  return nonEmpty(item.projectKey)
    && (item.mode === "alpha" || item.mode === "inherit" || item.mode === "custom")
    && Array.isArray(item.order)
    && item.order.every((id) => nonEmpty(id))
    && (item.autoHideEmptySubprojects === undefined || typeof item.autoHideEmptySubprojects === "boolean");
}

function parseState(value: unknown): SubprojectState {
  if (!value || typeof value !== "object") throw new Error("Invalid subproject state");
  const parsed = value as Partial<SubprojectState>;
  if (parsed.schemaVersion !== SUBPROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported subproject state schema: ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.subprojects) || !parsed.subprojects.every(validDefinition)) {
    throw new Error("Invalid subproject definitions");
  }
  if (!Array.isArray(parsed.assignments) || !parsed.assignments.every(validAssignment)) {
    throw new Error("Invalid subproject assignments");
  }
  if (parsed.sortSettings !== undefined && (!Array.isArray(parsed.sortSettings) || !parsed.sortSettings.every(validSortSetting))) {
    throw new Error("Invalid subproject sort settings");
  }
  const ids = new Set(parsed.subprojects.map((item) => item.id));
  if (ids.size !== parsed.subprojects.length || parsed.assignments.some((item) => !ids.has(item.subprojectId))) {
    throw new Error("Inconsistent subproject state");
  }
  const sessionIds = new Set<string>();
  for (const assignment of parsed.assignments) {
    if (sessionIds.has(assignment.sessionId)) throw new Error("Duplicate session assignment");
    sessionIds.add(assignment.sessionId);
  }
  const sortSettings = parsed.sortSettings ?? [];
  const sortProjects = new Set<string>();
  for (const setting of sortSettings) {
    const projectKey = canonicalProjectKey(setting.projectKey);
    if (sortProjects.has(projectKey)) throw new Error("Duplicate subproject sort setting");
    sortProjects.add(projectKey);
  }
  return {
    schemaVersion: 1,
    subprojects: [...parsed.subprojects],
    assignments: [...parsed.assignments],
    ...(parsed.sortSettings ? { sortSettings: [...parsed.sortSettings].map((item) => ({ ...item, order: [...item.order] })) } : {}),
  };
}

function load(file = stateFile()): SubprojectState {
  const state = runtime(file);
  if (state.loaded) return state.state;
  if (!existsSync(file)) {
    state.loaded = true;
    return state.state;
  }
  // Leave loaded=false when parsing fails so a later retry can observe a
  // repaired file instead of being permanently locked to the thrown read.
  const parsed = canonicalizeState(parseState(JSON.parse(readFileSync(file, "utf8"))));
  state.state = parsed;
  state.loaded = true;
  return parsed;
}

function persist(state: SubprojectState, file = stateFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writePrivateFileAtomicSync(file, JSON.stringify(state, null, 2));
}

function save(nextState: SubprojectState, file = stateFile()): SubprojectState {
  // Persist first. Cache replacement after this call is the commit point.
  persist(nextState, file);
  runtime(file).state = nextState;
  runtime(file).loaded = true;
  return nextState;
}

/** Remove assignments whose session file no longer exists in any Pi lifecycle root. */
export function pruneOrphanedSubprojectAssignments(): number {
  const state = load();
  if (state.assignments.length === 0) return 0;
  const runtimeState = runtime();
  if (runtimeState.orphanScanAttempted) return 0;
  const existingSessionIds = sessionIdsOnDisk();
  if (!existingSessionIds) {
    runtimeState.orphanScanAttempted = true;
    return 0;
  }
  const orphaned = state.assignments.filter((item) => !existingSessionIds.has(item.sessionId));
  if (orphaned.length === 0) {
    runtimeState.orphanScanAttempted = true;
    return 0;
  }
  save({
    ...cloneState(state),
    assignments: state.assignments.filter((item) => existingSessionIds.has(item.sessionId)),
  });
  runtimeState.orphanScanAttempted = true;
  return orphaned.length;
}

function required(value: unknown, name: string): string {
  if (!nonEmpty(value)) throw new SubprojectDomainError("subproject_required", `${name} is required`);
  return value.trim();
}

function normalizedLabel(label: string): string {
  return label.trim().toLowerCase();
}

function ensureUniqueLabel(state: SubprojectState, projectKey: string, label: string, excludeId?: string): void {
  if (state.subprojects.some((item) => item.id !== excludeId && projectKeysEqual(item.projectKey, projectKey) && normalizedLabel(item.label) === normalizedLabel(label))) {
    throw new SubprojectDomainError("subproject_label_conflict", "Subproject label already exists for project");
  }
}

export function readSubprojectState(): SubprojectState {
  pruneOrphanedSubprojectAssignments();
  return cloneState(load());
}

export function listSubprojects(projectKey?: string): SubprojectDefinition[] {
  const key = projectKey?.trim();
  return load().subprojects.filter((item) => !key || projectKeysEqual(item.projectKey, key)).map((item) => ({ ...item }));
}

export function listSubprojectSortSettings(projectKey?: string): SubprojectSortSetting[] {
  const key = projectKey?.trim();
  return (load().sortSettings ?? [])
    .filter((item) => !key || projectKeysEqual(item.projectKey, key))
    .map((item) => ({ ...item, order: [...item.order] }));
}

export function setSubprojectSort(
  projectKeyInput: string,
  modeInput: string,
  orderInput?: readonly string[],
  autoHideEmptySubprojectsInput?: boolean,
): SubprojectSortSetting {
  const projectKey = canonicalProjectKey(required(projectKeyInput, "projectKey"));
  if (modeInput !== "alpha" && modeInput !== "inherit" && modeInput !== "custom") {
    throw new SubprojectDomainError("subproject_required", "Invalid subproject sort mode");
  }
  const state = load();
  const existing = (state.sortSettings ?? []).find((item) => projectKeysEqual(item.projectKey, projectKey));
  const ownedIds = new Set(state.subprojects.filter((item) => projectKeysEqual(item.projectKey, projectKey)).map((item) => item.id));
  const requested = orderInput ?? existing?.order ?? [];
  const seen = new Set<string>();
  const order = [...requested, ...state.subprojects.filter((item) => projectKeysEqual(item.projectKey, projectKey)).map((item) => item.id)]
    .filter((id) => ownedIds.has(id) && !seen.has(id) && seen.add(id));
  const autoHideEmptySubprojects = autoHideEmptySubprojectsInput ?? existing?.autoHideEmptySubprojects;
  const setting: SubprojectSortSetting = {
    projectKey,
    mode: modeInput,
    order,
    ...(autoHideEmptySubprojects === undefined ? {} : { autoHideEmptySubprojects }),
  };
  const sortSettings = [...(state.sortSettings ?? []).filter((item) => !projectKeysEqual(item.projectKey, projectKey)), setting];
  save({ ...cloneState(state), sortSettings });
  return { ...setting, order: [...setting.order] };
}

export function setSubprojectAutoHideEmpty(projectKeyInput: string, enabled: boolean): SubprojectSortSetting {
  const projectKey = canonicalProjectKey(required(projectKeyInput, "projectKey"));
  const existing = (load().sortSettings ?? []).find((item) => projectKeysEqual(item.projectKey, projectKey));
  return setSubprojectSort(projectKey, existing?.mode ?? "custom", existing?.order, enabled);
}

export function hasSubprojects(projectKey: string): boolean {
  return listSubprojects(projectKey).length > 0;
}

export function createSubproject(projectKeyInput: string, labelInput: string): SubprojectDefinition {
  const projectKey = canonicalProjectKey(required(projectKeyInput, "projectKey"));
  const label = required(labelInput, "label");
  const state = load();
  ensureUniqueLabel(state, projectKey, label);
  const now = new Date().toISOString();
  const definition: SubprojectDefinition = { id: randomUUID(), projectKey, label, createdAt: now, updatedAt: now };
  save({ ...cloneState(state), subprojects: [...state.subprojects.map((item) => ({ ...item })), definition] });
  return { ...definition };
}

export function renameSubproject(idInput: string, labelInput: string): SubprojectDefinition {
  const id = required(idInput, "id");
  const label = required(labelInput, "label");
  const state = load();
  const definition = state.subprojects.find((item) => item.id === id);
  if (!definition) throw new SubprojectDomainError("subproject_not_found", "Subproject not found");
  ensureUniqueLabel(state, definition.projectKey, label, id);
  const nextDefinition = { ...definition, label, updatedAt: new Date().toISOString() };
  save({
    ...cloneState(state),
    subprojects: state.subprojects.map((item) => item.id === id ? nextDefinition : { ...item }),
  });
  return { ...nextDefinition };
}

export function setSubprojectHidden(idInput: string, hidden: boolean): SubprojectDefinition {
  const id = required(idInput, "id");
  const state = load();
  const definition = state.subprojects.find((item) => item.id === id);
  if (!definition) throw new SubprojectDomainError("subproject_not_found", "Subproject not found");
  const nextDefinition = { ...definition, hidden, updatedAt: new Date().toISOString() };
  save({
    ...cloneState(state),
    subprojects: state.subprojects.map((item) => item.id === id ? nextDefinition : { ...item }),
  });
  return { ...nextDefinition };
}

/** Delete category only; one atomic write also removes all category assignments. */
export function deleteSubproject(idInput: string): SubprojectState {
  const id = required(idInput, "id");
  const state = load();
  if (!state.subprojects.some((item) => item.id === id)) {
    throw new SubprojectDomainError("subproject_not_found", "Subproject not found");
  }
  save({
    ...cloneState(state),
    subprojects: state.subprojects.filter((item) => item.id !== id).map((item) => ({ ...item })),
    assignments: state.assignments.filter((item) => item.subprojectId !== id).map((item) => ({ ...item })),
    ...(state.sortSettings ? {
      sortSettings: state.sortSettings.map((item) => ({ ...item, order: item.order.filter((subprojectId) => subprojectId !== id) })),
    } : {}),
  });
  return readSubprojectState();
}

export function setSubprojectForSessions(
  projectKeyInput: string,
  sessionIdsInput: readonly string[],
  subprojectIdInput: string | null,
): SubprojectAssignment[] {
  const projectKey = canonicalProjectKey(required(projectKeyInput, "projectKey"));
  const sessionIds = [...new Set(sessionIdsInput.map((value) => required(value, "sessionId")))];
  if (sessionIds.length === 0) return [];
  const state = load();
  let subprojectId: string | null = null;
  if (subprojectIdInput !== null) {
    subprojectId = required(subprojectIdInput, "subprojectId");
    const definition = state.subprojects.find((item) => item.id === subprojectId);
    if (!definition) throw new SubprojectDomainError("subproject_not_found", "Subproject not found");
    if (!projectKeysEqual(definition.projectKey, projectKey)) throw new SubprojectDomainError("subproject_project_mismatch", "Subproject belongs to another project");
  }
  const ids = new Set(sessionIds);
  const retained = state.assignments.filter((item) => {
    if (!ids.has(item.sessionId)) return true;
    if (subprojectId !== null) return false;
    return !projectKeysEqual(item.projectKey, projectKey);
  }).map((item) => ({ ...item }));
  const next = subprojectId === null
    ? []
    : sessionIds.map((sessionId) => ({ sessionId, projectKey, subprojectId }));
  save({ ...cloneState(state), assignments: [...retained, ...next] });
  return next.map((item) => ({ ...item }));
}

export function assignSession(projectKeyInput: string, sessionIdInput: string, subprojectIdInput: string): SubprojectAssignment {
  const projectKey = canonicalProjectKey(required(projectKeyInput, "projectKey"));
  const sessionId = required(sessionIdInput, "sessionId");
  const subprojectId = required(subprojectIdInput, "subprojectId");
  const state = load();
  const definition = state.subprojects.find((item) => item.id === subprojectId);
  if (!definition) throw new SubprojectDomainError("subproject_not_found", "Subproject not found");
  if (!projectKeysEqual(definition.projectKey, projectKey)) throw new SubprojectDomainError("subproject_project_mismatch", "Subproject belongs to another project");
  const assignment = { sessionId, projectKey: canonicalProjectKey(definition.projectKey), subprojectId };
  save({
    ...cloneState(state),
    assignments: [...state.assignments.filter((item) => item.sessionId !== sessionId).map((item) => ({ ...item })), assignment],
  });
  return { ...assignment };
}

export function unassignSession(sessionIdInput: string, projectKeyInput?: string): SubprojectState {
  const sessionId = required(sessionIdInput, "sessionId");
  const projectKey = projectKeyInput?.trim();
  const state = load();
  save({
    ...cloneState(state),
    assignments: state.assignments.filter((item) => item.sessionId !== sessionId || (projectKey && !projectKeysEqual(item.projectKey, projectKey))).map((item) => ({ ...item })),
  });
  return readSubprojectState();
}

export function assignmentForSession(sessionIdInput: string, projectKeyInput?: string): SubprojectAssignment | undefined {
  const sessionId = required(sessionIdInput, "sessionId");
  const projectKey = projectKeyInput?.trim();
  const assignment = load().assignments.find((item) => item.sessionId === sessionId && (!projectKey || projectKeysEqual(item.projectKey, projectKey)));
  return assignment ? { ...assignment } : undefined;
}

/** Restore assignment captured before a session delete; persistence remains the commit point. */
export function restoreSubprojectAssignment(assignment: SubprojectAssignment): SubprojectAssignment {
  const state = load();
  const definition = state.subprojects.find((item) => item.id === assignment.subprojectId);
  if (!definition) throw new SubprojectDomainError("subproject_not_found", "Subproject not found");
  if (!projectKeysEqual(definition.projectKey, assignment.projectKey)) throw new SubprojectDomainError("subproject_project_mismatch", "Subproject belongs to another project");
  save({
    ...cloneState(state),
    assignments: [...state.assignments.filter((item) => item.sessionId !== assignment.sessionId).map((item) => ({ ...item })), { ...assignment }],
  });
  return { ...assignment };
}

export function subprojectForSession(sessionId: string, projectKey: string): SubprojectDefinition | undefined {
  const state = load();
  const assignment = state.assignments.find((item) => item.sessionId === sessionId && projectKeysEqual(item.projectKey, projectKey));
  const definition = assignment && state.subprojects.find((item) => item.id === assignment.subprojectId && projectKeysEqual(item.projectKey, projectKey));
  return definition ? { ...definition } : undefined;
}

export function applySubprojectAssignments<T extends { id: string; projectKey?: string }>(sessions: readonly T[]): T[] {
  const state = load();
  const definitions = new Map(state.subprojects.map((item) => [item.id, item]));
  const assignments = new Map(state.assignments.map((item) => [item.sessionId, item]));
  return sessions.map((session) => {
    const assignment = assignments.get(session.id);
    const definition = assignment && session.projectKey && projectKeysEqual(session.projectKey, assignment.projectKey) ? definitions.get(assignment.subprojectId) : undefined;
    return definition ? { ...session, subprojectId: definition.id } : { ...session, subprojectId: undefined };
  });
}

/** Test-only cache reset; does not touch files. */
export function resetSubprojectStateForTests(): void {
  globalThis.__piSubprojectStateRuntimes?.clear();
}
