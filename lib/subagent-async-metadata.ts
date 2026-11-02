import { lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { asyncMetadataKey, asyncStatusChildId } from "./async-metadata-key";

export interface AsyncModelMetadata {
  model?: string;
  modelProvider?: string;
  thinking?: string;
  agent?: string;
}

type JsonRecord = Record<string, unknown>;
const MAX_RUNS = 128;
const MAX_IDS = 512;
const MAX_TEXT = 160;
const NESTED_KEYS = ["children", "nestedChildren", "workflowChildren"] as const;

function tempScopeId(): string {
  if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key]?.trim();
    if (value) return `user-${value.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  }
  try {
    const value = userInfo().username?.trim();
    if (value) return `user-${value.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  } catch {
    // Fall through to a shared scope.
  }
  return "shared";
}

function asyncRunRoot(): string {
  const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return join(configured ? resolve(configured) : join(tmpdir(), `pi-subagents-${tempScopeId()}`), "async-subagent-runs");
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_TEXT) : undefined;
}

function sessionMatches(statusSessionId: unknown, requestedSessionId: string): boolean {
  if (typeof statusSessionId !== "string") return false;
  const statusStr = statusSessionId.trim();
  const reqStr = requestedSessionId.trim();
  if (!statusStr || !reqStr) return false;
  if (statusStr === reqStr) return true;
  return statusStr.includes(reqStr) || reqStr.includes(statusStr);
}

function metadataFor(value: JsonRecord): AsyncModelMetadata | undefined {
  const model = text(value.model) ?? text(value.requestedModel);
  const modelProvider = text(value.modelProvider);
  const thinking = text(value.thinking);
  const agent = text(value.agent);
  if (!model && !modelProvider && !thinking && !agent) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    ...(thinking ? { thinking } : {}),
    ...(agent ? { agent } : {}),
  };
}

function readJson(path: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function statusPathFor(root: string, entry: Dirent): string | undefined {
  const runPath = join(root, entry.name);
  try {
    const runStat = lstatSync(runPath);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) return undefined;
    const canonicalRoot = realpathSync(root);
    const canonicalRun = realpathSync(runPath);
    if (!isWithin(canonicalRoot, canonicalRun)) return undefined;
    const statusPath = join(runPath, "status.json");
    const statusStat = lstatSync(statusPath);
    if (!statusStat.isFile() || statusStat.isSymbolicLink()) return undefined;
    const canonicalStatus = realpathSync(statusPath);
    return canonicalStatus === join(canonicalRun, "status.json") ? statusPath : undefined;
  } catch {
    return undefined;
  }
}

function mergeMetadata(result: Map<string, AsyncModelMetadata>, key: string, metadata: AsyncModelMetadata | undefined): void {
  if (!metadata) return;
  const existing = result.get(key);
  if (existing) {
    result.set(key, { ...existing, ...metadata });
  } else if (result.size < MAX_IDS) {
    result.set(key, metadata);
  }
}

function setMetadata(result: Map<string, AsyncModelMetadata>, runId: string, path: readonly string[], value: JsonRecord): void {
  mergeMetadata(result, asyncMetadataKey(runId, path), metadataFor(value));
}

function addNestedRun(result: Map<string, AsyncModelMetadata>, rootRunId: string, path: readonly string[], value: JsonRecord): void {
  setMetadata(result, rootRunId, path, value);
  const steps = Array.isArray(value.steps) ? value.steps.filter(record) : [];
  if (steps.length === 1 && !metadataFor(value)) setMetadata(result, rootRunId, path, steps[0]);
  steps.forEach((step, index) => addStep(result, rootRunId, path, step, index));
  for (const key of NESTED_KEYS) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      nested.filter(record).forEach((child, index) => {
        const childId = text(child.id) ?? `nested:${index}`;
        addNestedRun(result, rootRunId, [...path, childId], child);
      });
    }
  }
}

function addStep(result: Map<string, AsyncModelMetadata>, rootRunId: string, parentPath: readonly string[], step: JsonRecord, index: number): void {
  const childId = asyncStatusChildId(step, index);
  const path = [...parentPath, childId];
  setMetadata(result, rootRunId, path, step);
  const children = step.children;
  if (Array.isArray(children)) {
    children.filter(record).forEach((child, childIndex) => {
      const nestedId = text(child.id) ?? `nested:${childIndex}`;
      addNestedRun(result, rootRunId, [...path, nestedId], child);
    });
  }
}

function rootMetadataForStatus(status: JsonRecord): AsyncModelMetadata | undefined {
  const direct = metadataFor(status);
  const steps = Array.isArray(status.steps) ? status.steps.filter(record) : [];
  const stepMetadata = steps.length === 1 ? metadataFor(steps[0]) : undefined;
  if (!direct && !stepMetadata) return undefined;
  return { ...stepMetadata, ...direct };
}

function projectStatus(
  status: JsonRecord,
  runId: string,
  statusesByRunId: ReadonlyMap<string, JsonRecord>,
): Map<string, AsyncModelMetadata> {
  const result = new Map<string, AsyncModelMetadata>();
  addNestedRun(result, runId, [], status);

  const steps = Array.isArray(status.steps) ? status.steps.filter(record) : [];
  steps.forEach((step, index) => {
    const childRunId = text(step.runId);
    const childStatus = childRunId ? statusesByRunId.get(childRunId) : undefined;
    const childMetadata = childStatus ? rootMetadataForStatus(childStatus) : undefined;
    if (!childMetadata) return;
    const key = asyncMetadataKey(runId, [asyncStatusChildId(step, index)]);
    mergeMetadata(result, key, childMetadata);
    mergeMetadata(result, key, metadataFor(step));
  });

  const parentRunId = text(status.parentWorkflowRunId) ?? text(status.parentRunId);
  const workflowKey = text(status.workflowKey);
  const rootMetadata = rootMetadataForStatus(status);
  if (parentRunId && workflowKey && rootMetadata) {
    mergeMetadata(result, asyncMetadataKey(parentRunId, [workflowKey]), rootMetadata);
  }
  return result;
}

export function readAsyncModelMetadata(sessionId: string, ids: readonly string[]): Record<string, AsyncModelMetadata> {
  const requested = new Set(ids.map((id) => id.trim()).filter(Boolean).slice(0, MAX_IDS));
  if (!sessionId.trim() || requested.size === 0) return {};

  let entries: Dirent[];
  try {
    entries = readdirSync(asyncRunRoot(), { withFileTypes: true });
  } catch {
    return {};
  }

  const root = asyncRunRoot();
  const statuses: Array<{ runId: string; status: JsonRecord }> = [];
  const statusesByRunId = new Map<string, JsonRecord>();
  for (const entry of entries.slice(0, MAX_RUNS)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const statusPath = statusPathFor(root, entry);
    const status = statusPath ? readJson(statusPath) : undefined;
    const runId = status && (text(status.runId) ?? text(status.id));
    if (!status || !sessionMatches(status.sessionId, sessionId) || runId !== entry.name) continue;
    statuses.push({ runId, status });
    statusesByRunId.set(runId, status);
  }

  const result = new Map<string, AsyncModelMetadata>();
  for (const { runId, status } of statuses) {
    for (const [key, metadata] of projectStatus(status, runId, statusesByRunId)) {
      if (requested.has(key)) mergeMetadata(result, key, metadata);
    }
    if (result.size >= requested.size && Array.from(requested).every((k) => Boolean(result.get(k)?.model && result.get(k)?.agent))) break;
  }
  return Object.fromEntries(result);
}
