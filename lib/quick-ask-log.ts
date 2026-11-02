import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSessionProjection, SessionManager, type FileEntry, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, SystemMessage } from "@earendil-works/pi-ai";
import type { Base64ImageAttachment } from "./image-attachments";
import { QuickAskError, quickAskErrorText } from "./quick-ask-context";
import {
  createQuickAskDerivativeUsageEvent,
  nativeUserImages,
  projectSessionQuickAsks,
  quickAskContextAnchor,
  type QuickAskEntry, type QuickAskUsageEvent,
} from "./quick-ask-storage";

export const QUICK_ASK_BRANCH = "quick_ask_branch";
export const QUICK_ASK_RUN = "quick_ask_run";
export const QUICK_ASK_PROMOTED_BRANCH = "quick_ask_promoted_branch";
export const QUICK_ASK_TRANSFER_PENDING = "quick_ask_transfer_pending";
export const QUICK_ASK_TRANSFER = "quick_ask_transfer";
export const QUICK_ASK_TRANSFER_FAILED = "quick_ask_transfer_failed";

export interface QuickAskScope { threadId: string; branchId: string }
export interface QuickAskBranch extends QuickAskScope {
  version: 1;
  id: string;
  contextAnchorId: string | null;
  createdAt: number;
  sourceSystem?: SystemMessage;
  /** The anchor this topic used before the main line compacted past it. */
  rebasedFromAnchorId?: string | null;
}
export type QuickAskRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface QuickAskRunSnapshot extends QuickAskScope {
  id: string;
  status: QuickAskRunStatus;
  question: string;
  images: Base64ImageAttachment[];
  answer: string;
  thinking: string;
  createdAt: number;
  revision: number;
  error?: string;
  errorStatus?: number;
  entry?: QuickAskEntry;
}
export interface QuickAskForkResult {
  success: true;
  newSessionId: string;
  newSessionPath: string;
  entriesCount: number;
  subprojectAssignmentFailed?: boolean;
}

export function quickAskPromotedBranches(entries: readonly SessionEntry[]): string[] {
  const branches = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== QUICK_ASK_PROMOTED_BRANCH) continue;
    const branchId = (entry.data as { branchId?: unknown } | undefined)?.branchId;
    if (typeof branchId === "string" && branchId && branchId !== "main") branches.add(branchId);
  }
  return [...branches];
}

export function quickAskScopeKey(scope: QuickAskScope): string {
  return JSON.stringify([scope.branchId, scope.threadId]);
}
export function sameQuickAskScope(left: QuickAskScope, right: QuickAskScope): boolean {
  return (left.threadId ?? "default") === (right.threadId ?? "default")
    && (left.branchId ?? "main") === (right.branchId ?? "main");
}

interface QuickAskTransferDestination {
  result: QuickAskForkResult;
  prefixBytes: number;
  prefixSha256: string;
}
interface QuickAskTransferReservation {
  attemptId: string;
  destination: QuickAskTransferDestination;
}
type QuickAskTransferState = { status: "completed"; result: QuickAskForkResult }
  | { status: "pending"; reservation?: QuickAskTransferReservation };

export function quickAskTransferState(entries: readonly SessionEntry[], scope: QuickAskScope): QuickAskTransferState | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "custom" || !entry.data || !sameQuickAskScope(entry.data as QuickAskScope, scope)) continue;
    const data = entry.data as Partial<QuickAskTransferReservation> & { result?: QuickAskForkResult; effect?: string };
    if (entry.customType === "quick_ask_thread_delete") return undefined;
    if (entry.customType === QUICK_ASK_TRANSFER_FAILED && data.effect === "none") return undefined;
    if (entry.customType === QUICK_ASK_TRANSFER && data.result) return { status: "completed", result: data.result };
    if (entry.customType === QUICK_ASK_TRANSFER_PENDING) {
      if (data.result) return { status: "completed", result: data.result };
      return { status: "pending", ...(data.attemptId && data.destination
        ? { reservation: { attemptId: data.attemptId, destination: data.destination } } : {}) };
    }
  }
  return undefined;
}

function transferPending(): QuickAskError {
  return new QuickAskError("Side Ask transfer outcome is unconfirmed; retry after the reserved destination recovers", 409);
}

export function quickAskTransferResult(entries: readonly SessionEntry[], scope: QuickAskScope): QuickAskForkResult | undefined {
  const state = quickAskTransferState(entries, scope);
  if (state?.status === "pending") throw transferPending();
  return state?.result;
}

/**
 * The stored fields of a topic anchor. Records written by earlier versions also hold the whole first submission
 * (question, attachments, model...); reading only these fields keeps that out of every record written afterwards.
 */
function anchorOf(data: QuickAskBranch): QuickAskBranch {
  return {
    version: 1, id: data.id, threadId: data.threadId, branchId: data.branchId,
    contextAnchorId: data.contextAnchorId, createdAt: data.createdAt,
    ...(data.sourceSystem ? { sourceSystem: data.sourceSystem } : {}),
    ...(data.rebasedFromAnchorId !== undefined ? { rebasedFromAnchorId: data.rebasedFromAnchorId } : {}),
  };
}

export function findQuickAskBranch(entries: readonly SessionEntry[], scope: QuickAskScope): QuickAskBranch | undefined {
  let branch: QuickAskBranch | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const data = entry.data as QuickAskBranch | undefined;
    if (!data || !sameQuickAskScope(data, scope)) continue;
    if (entry.customType === QUICK_ASK_BRANCH && data.version === 1) branch = anchorOf(data);
    else if (entry.customType === "quick_ask_thread_delete") branch = undefined;
  }
  return branch;
}

export function quickAskItems(entries: readonly SessionEntry[], scope: QuickAskScope): QuickAskEntry[] {
  return projectSessionQuickAsks(entries).filter((item) =>
    (item.data.threadId ?? item.threadId ?? "default") === scope.threadId
      && (item.data.branchId ?? item.branchId ?? "main") === scope.branchId);
}

export function createQuickAskBranch(
  entries: readonly SessionEntry[], scope: QuickAskScope, currentLeafId: string | null, sourceSystem?: SystemMessage,
): QuickAskBranch {
  const first = quickAskItems(entries, scope)[0];
  if (first && !Object.hasOwn(first.data, "contextAnchorId") && !Object.hasOwn(first, "parentId")) {
    throw new QuickAskError("Side Ask source anchor is unavailable in this historical record", 409);
  }
  return {
    version: 1, id: randomUUID(), threadId: scope.threadId, branchId: scope.branchId,
    contextAnchorId: first ? quickAskContextAnchor(first) : currentLeafId,
    createdAt: Date.now(), ...(sourceSystem ? { sourceSystem } : {}),
  };
}

/**
 * A topic keeps its anchor until the active main line compacts after it; it then continues from the
 * latest such checkpoint, as the main session itself does. Checkpoints on other lines never move it.
 * The caller re-derives `sourceSystem` for the new anchor.
 */
export function rebaseQuickAskBranch(source: SessionManager, branch: QuickAskBranch): QuickAskBranch | undefined {
  const leafId = source.getLeafId();
  if (!leafId) return undefined;
  const path = source.getBranch(leafId);
  const after = branch.contextAnchorId === null ? 0 : path.findIndex((entry) => entry.id === branch.contextAnchorId) + 1;
  if (branch.contextAnchorId !== null && after === 0) return undefined;
  const checkpoint = path.slice(after).findLast((entry) => entry.type === "compaction");
  return checkpoint ? { ...branch, contextAnchorId: checkpoint.id, rebasedFromAnchorId: branch.contextAnchorId } : undefined;
}

/** Rechain an immutable selected path without changing its native entry identities. */
function rechain(entries: readonly SessionEntry[]): SessionEntry[] {
  let parentId: string | null = null;
  return entries.map((entry) => {
    const copy = { ...entry, parentId };
    parentId = entry.id;
    return copy;
  });
}

/** What a model call is told where the frozen anchor sits mid tool call; the SDK would otherwise report a failed call. */
export const QUICK_ASK_PENDING_TOOL_RESULT = "（创建侧边提问时，该工具调用仍在执行，结果尚未返回；之后的结果不在本侧问上下文中。）";

/** Calls of the newest assistant turn that had no result when the anchor was frozen. A later user message means abandoned, not in flight. */
function pendingToolResults(path: readonly SessionEntry[], idPrefix: string): SessionEntry[] {
  const answered = new Set<string>();
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") { answered.add(message.toolCallId); continue; }
    if (message.role !== "assistant" || message.stopReason !== "toolUse") return [];
    return message.content.flatMap((block): SessionEntry[] => block.type !== "toolCall" || answered.has(block.id) ? [] : [{
      type: "message", id: `${idPrefix}-pending-${block.id}`, parentId: null, timestamp: entry.timestamp,
      message: { role: "toolResult", toolCallId: block.id, toolName: block.name, isError: false, timestamp: message.timestamp,
        content: [{ type: "text", text: QUICK_ASK_PENDING_TOOL_RESULT }] },
    }]);
  }
  return [];
}

/**
 * Read-only fork projection: this manager never owns a file or changes the main leaf.
 * `settleInFlightTools` adds the neutral result for model requests only; replays and forks keep the persisted native messages.
 */
export function quickAskBranchManager(
  source: SessionManager, branch: QuickAskBranch, items = quickAskItems(source.getEntries(), branch),
  copyUsage = false, throughEntryId?: string, settleInFlightTools = false,
): SessionManager {
  const header = source.getHeader();
  if (!header) throw new Error("Side Ask source session header is unavailable");
  const sourcePath = branch.contextAnchorId === null ? [] : source.getBranch(branch.contextAnchorId);
  if (branch.contextAnchorId !== null && sourcePath.at(-1)?.id !== branch.contextAnchorId) {
    throw new QuickAskError("Side Ask source branch no longer exists", 409);
  }
  const contextPath = sourcePath.map((entry): SessionEntry => {
    if (entry.type !== "custom" || !entry.customType.startsWith("quick_ask")) return entry;
    return { type: "custom", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
      customType: "reader.fork_source", data: { sessionId: source.getSessionId(), entryId: entry.id } };
  });
  const seed: SessionEntry[] = [];
  if (branch.sourceSystem && buildSessionProjection(contextPath, branch.contextAnchorId).messages[0]?.role !== "system") {
    const checkpointIndex = contextPath.findLastIndex((entry) => entry.type === "compaction");
    const checkpoint = contextPath[checkpointIndex];
    if (checkpoint?.type === "compaction") {
      contextPath[checkpointIndex] = { ...checkpoint, systemMessage: branch.sourceSystem };
    } else seed.push({ type: "message", id: `${branch.id}-system`, parentId: null,
      timestamp: new Date(branch.createdAt).toISOString(), message: branch.sourceSystem });
  }
  const selected = structuredClone([...seed, ...contextPath]);
  if (settleInFlightTools) selected.push(...pendingToolResults(selected, branch.id));
  for (const item of items) {
    const native = item.data.nativeEntries?.length
      ? structuredClone(item.data.nativeEntries)
      : legacyQuickAskEntries(item);
    if (copyUsage) for (const entry of native) {
      if (entry.type === "message" && entry.message.role === "assistant") Object.assign(entry.message, {
        usageEvent: createQuickAskDerivativeUsageEvent(source.getSessionId(), item.id, item.usageEvent, "copy"),
      });
    }
    selected.push(...native);
  }
  selected.push(...quickAskOutcomeEntries(source, branch, copyUsage, throughEntryId));
  return SessionManager.inMemory(source.getCwd(), undefined, [
    { ...header, id: branch.id, parentSession: source.getSessionFile() }, ...rechain(selected),
  ]);
}

/** The branch as the next model call sees it. */
export function quickAskRequestManager(source: SessionManager, branch: QuickAskBranch): SessionManager {
  return quickAskBranchManager(source, branch, undefined, false, undefined, true);
}

interface NativeOutcomeData extends Partial<QuickAskScope> {
  id?: string;
  runId?: string;
  nativeEntries?: SessionEntry[];
  model?: string;
  provider?: string;
  usage?: QuickAskEntry["usage"];
  usageEvent?: QuickAskUsageEvent;
}

/** Unsuccessful turns retain original messages/state as non-model metadata. */
function quickAskOutcomeEntries(source: SessionManager, branch: QuickAskBranch, copyUsage: boolean, throughEntryId?: string): SessionEntry[] {
  const entries = source.getEntries();
  const born = entries.findIndex((entry) => entry.type === "custom" && entry.customType === QUICK_ASK_BRANCH
    && (entry.data as { id?: string })?.id === branch.id);
  const reset = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === "quick_ask_thread_delete"
    && entry.data && sameQuickAskScope(entry.data as QuickAskScope, branch));
  const end = throughEntryId ? entries.findIndex((entry) => entry.id === throughEntryId) + 1 : entries.length;
  if (throughEntryId && !end) throw new QuickAskError("Quick Ask fork point was not found", 404);
  const records = entries.slice(Math.max(born + 1, reset + 1), end);
  const admissions = new Map<string, { entry: SessionEntry; data: NativeOutcomeData }>();
  const outcomes = new Map<string, { entry: SessionEntry; data: NativeOutcomeData }>();
  const completed = new Set<string>();
  for (const entry of records) {
    if (entry.type !== "custom" || !entry.data) continue;
    const data = entry.data as NativeOutcomeData;
    if (!sameQuickAskScope(data as QuickAskScope, branch)) continue;
    if (entry.customType === "quick_ask" && data.runId) completed.add(data.runId);
    if (entry.customType === QUICK_ASK_RUN && data.id && Array.isArray(data.nativeEntries)
      && data.nativeEntries.some((native) => native.type === "message" && native.message.role === "user")) {
      admissions.set(data.id, { entry, data });
    }
    if (entry.customType === "quick_ask_outcome" && data.runId) outcomes.set(data.runId, { entry, data });
  }
  return quickAskRunSnapshots(records, [], false).flatMap((run): SessionEntry[] => {
    const admission = admissions.get(run.id);
    if (!admission || completed.has(run.id) || !sameQuickAskScope(run, branch)) return [];
    const outcome = outcomes.get(run.id);
    const nativeEntries = structuredClone([...(admission.data.nativeEntries ?? []), ...(outcome?.data.nativeEntries ?? [])]);
    const usageEvent = outcome?.data.usageEvent && copyUsage
      ? createQuickAskDerivativeUsageEvent(source.getSessionId(), outcome.entry.id, outcome.data.usageEvent, "copy")
      : outcome?.data.usageEvent;
    if (usageEvent) for (const entry of nativeEntries) {
      if (entry.type === "message" && entry.message.role === "assistant") Object.assign(entry.message, { usageEvent });
    }
    return [{ type: "custom", id: `${admission.entry.id}-outcome`, parentId: null,
      timestamp: outcome?.entry.timestamp ?? admission.entry.timestamp, customType: "reader.side_ask_outcome",
      data: { runId: run.id, threadId: branch.threadId, branchId: branch.branchId, contextAnchorId: branch.contextAnchorId, nativeEntries,
        state: { status: run.status, createdAt: run.createdAt, revision: run.revision,
          error: run.error, answer: run.answer, thinking: run.thinking },
        ...(outcome ? { provider: outcome.data.provider, model: outcome.data.model, usage: outcome.data.usage, usageEvent } : {}),
      } }];
  });
}

function legacyQuickAskEntries(item: QuickAskEntry): SessionMessageEntry[] {
  const user: SessionMessageEntry = {
    type: "message", id: `${item.id}-user`, parentId: null, timestamp: item.timestamp,
    message: { role: "user", content: [
      { type: "text", text: item.data.question },
      ...(item.data.images ?? []).map((image) => ({ type: "image" as const, ...image })),
    ], timestamp: item.data.createdAt },
  };
  const usage = item.usage ?? item.data.usage;
  const message = {
    role: "assistant", content: [
      ...(item.data.thinking ? [{ type: "thinking" as const, thinking: item.data.thinking }] : []),
      { type: "text" as const, text: item.data.answer },
    ], api: "chat",
    provider: item.provider ?? item.data.provider ?? "unknown", model: item.model ?? item.data.model ?? "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage },
    stopReason: "stop", timestamp: item.data.createdAt,
  } as AssistantMessage;
  Object.assign(message, { usageEvent: item.usageEvent });
  return [user, { type: "message", id: `${item.id}-assistant`, parentId: user.id, timestamp: item.timestamp, message }];
}

interface QuickAskMaterialization {
  reservation: QuickAskTransferReservation;
  contents: string;
  context: string;
}

class QuickAskMaterializationError extends QuickAskError {
  constructor(error: unknown, readonly effect: "none" | "unknown") {
    super(quickAskErrorText(error));
  }
}

/** Allocate and serialize before reserving the transfer. No destination file exists yet. */
function prepareQuickAskMaterialization(source: SessionManager, branch: QuickAskBranch, items?: QuickAskEntry[], throughEntryId?: string): QuickAskMaterialization {
  const replay = quickAskBranchManager(source, branch, items, true, throughEntryId);
  const allocated = SessionManager.create(source.getCwd(), source.getSessionDir(), { parentSession: source.getSessionFile() });
  const file = allocated.getSessionFile();
  if (!file) throw new Error("Fork destination was not allocated");
  const entries = replay.getEntries().map((entry): SessionEntry => {
    if (entry.type !== "custom" || !entry.customType.startsWith("quick_ask")) return entry;
    // Preserve structural identities without copying unrelated side-branch payloads or usage.
    return { type: "custom", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
      customType: "reader.fork_source", data: { sessionId: source.getSessionId(), entryId: entry.id } };
  });
  const records: FileEntry[] = [allocated.getHeader()!, ...entries];
  const contents = records.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  return { contents, context: JSON.stringify(replay.buildSessionContext()), reservation: {
    attemptId: randomUUID(), destination: {
      result: { success: true, newSessionId: allocated.getSessionId(), newSessionPath: file, entriesCount: entries.length },
      prefixBytes: Buffer.byteLength(contents), prefixSha256: createHash("sha256").update(contents).digest("hex"),
    },
  } };
}

function writeQuickAskMaterialization(prepared: QuickAskMaterialization): QuickAskForkResult {
  const { result } = prepared.reservation.destination;
  const file = result.newSessionPath;
  let created = false;
  try {
    const fd = openSync(file, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, prepared.contents); fsyncSync(fd); }
    finally { closeSync(fd); }
    const opened = SessionManager.open(file, path.dirname(file));
    if (opened.getSessionId() !== result.newSessionId || JSON.stringify(opened.buildSessionContext()) !== prepared.context) {
      throw new Error("Materialized Side Ask context differs from its logical branch");
    }
    return result;
  } catch (error) {
    let effect: "none" | "unknown" = "unknown";
    if (created) {
      try { unlinkSync(file); effect = "none"; }
      catch { /* An unconfirmed cleanup must retain the exact destination for reconciliation. */ }
    } else if (["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EROFS", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE"]
      .includes((error as NodeJS.ErrnoException)?.code ?? "")) {
      effect = "none";
    }
    throw new QuickAskMaterializationError(error, effect);
  }
}

/** A matching original prefix proves the same target even after it receives later turns. */
function recoverQuickAskMaterialization(source: SessionManager, reservation?: QuickAskTransferReservation): QuickAskForkResult {
  if (!reservation) throw transferPending(); // Legacy pending records have no safe target identity.
  const { result, prefixBytes, prefixSha256 } = reservation.destination;
  if (!result || result.success !== true || typeof result.newSessionPath !== "string"
    || path.resolve(path.dirname(result.newSessionPath)) !== path.resolve(source.getSessionDir())
    || !Number.isSafeInteger(result.entriesCount) || result.entriesCount < 0
    || !Number.isSafeInteger(prefixBytes) || prefixBytes <= 0 || !/^[a-f0-9]{64}$/.test(prefixSha256)) throw transferPending();
  let fd: number | undefined;
  try {
    fd = openSync(result.newSessionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < prefixBytes) throw transferPending();
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(prefixBytes, 64 * 1024));
    let offset = 0;
    let header = "";
    while (offset < prefixBytes) {
      const length = readSync(fd, chunk, 0, Math.min(chunk.length, prefixBytes - offset), offset);
      if (!length) throw transferPending();
      const bytes = chunk.subarray(0, length);
      hash.update(bytes);
      if (!header.includes("\n")) header += bytes.toString("utf8");
      offset += length;
    }
    if (hash.digest("hex") !== prefixSha256) throw transferPending();
    const identity = JSON.parse(header.split("\n", 1)[0]);
    if (identity.type !== "session" || identity.id !== result.newSessionId || identity.cwd !== source.getCwd()
      || identity.parentSession !== source.getSessionFile()) throw transferPending();
    return result;
  } catch { throw transferPending(); }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Read-only descriptor cleanup has no transfer effect. */ } } }
}

/** The hot and cold whole-thread transfers share reservation, failure and recovery semantics. */
export function materializeQuickAskTransfer(
  source: SessionManager, scope: QuickAskScope, append: (customType: string, data: unknown) => unknown,
): QuickAskForkResult {
  const entries = source.getEntries();
  const state = quickAskTransferState(entries, scope);
  if (state?.status === "completed") return state.result;
  if (state?.status === "pending") return recoverQuickAskMaterialization(source, state.reservation);
  const items = quickAskItems(entries, scope);
  if (!items.length) throw new QuickAskError("No completed side-branch messages to fork", 400);
  const branch = findQuickAskBranch(entries, scope) ?? createQuickAskBranch(entries, scope, source.getLeafId());
  const prepared = prepareQuickAskMaterialization(source, branch, items);
  append(QUICK_ASK_TRANSFER_PENDING, { ...scope, ...prepared.reservation });
  try { return writeQuickAskMaterialization(prepared); }
  catch (error) {
    if (error instanceof QuickAskMaterializationError && error.effect === "none") {
      append(QUICK_ASK_TRANSFER_FAILED, { ...scope, attemptId: prepared.reservation.attemptId,
        effect: "none", error: quickAskErrorText(error) });
    }
    throw error;
  }
}

/** Materialize only this logical branch; never call createBranchedSession on a live source. */
export function materializeQuickAskBranch(source: SessionManager, branch: QuickAskBranch, items?: QuickAskEntry[], throughEntryId?: string): QuickAskForkResult {
  if (throughEntryId) {
    const entries = source.getEntries();
    const end = entries.findIndex((entry) => entry.id === throughEntryId) + 1;
    if (!end) throw new QuickAskError("Quick Ask fork point was not found", 404);
    const history = entries.slice(0, end);
    const scope = { threadId: branch.threadId, branchId: branch.branchId };
    // A historical fork owns its checkpoint and system, independently of later topic rebases.
    branch = findQuickAskBranch(history, scope) ?? createQuickAskBranch(history, scope, null);
  }
  return writeQuickAskMaterialization(prepareQuickAskMaterialization(source, branch, items, throughEntryId));
}

/** Exact request identities proven deleted by the existing log, including a cancellation before admission. */
export function quickAskDeletedRuns(entries: readonly SessionEntry[]): Map<string, QuickAskScope> {
  const known = new Map<string, QuickAskScope>();
  const completed = new Map<string, string>();
  const deletedTargets = new Set<string>();
  const deleted = new Map<string, QuickAskScope>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const data = entry.data as (Partial<QuickAskScope> & { id?: string; runId?: string; requestId?: string; targetId?: string }) | undefined;
    const legacy = entry as Partial<QuickAskEntry> & { targetId?: string };
    const scope = { threadId: data?.threadId ?? legacy.threadId ?? "default", branchId: data?.branchId ?? legacy.branchId ?? "main" };
    if (entry.customType === QUICK_ASK_RUN && data?.id) known.set(data.id, scope);
    else if (entry.customType === "quick_ask" && data?.runId) {
      known.set(data.runId, scope);
      completed.set(entry.id, data.runId);
      if (deletedTargets.has(entry.id)) deleted.set(data.runId, scope);
    } else if (entry.customType === "quick_ask_delete") {
      const target = data?.targetId ?? legacy.targetId;
      if (!target) continue;
      deletedTargets.add(target);
      const id = completed.get(target);
      if (id && known.has(id)) deleted.set(id, known.get(id)!);
    } else if (entry.customType === "quick_ask_thread_delete") {
      for (const [id, previous] of known) if (sameQuickAskScope(previous, scope)) deleted.set(id, previous);
      if (data?.requestId && (!known.has(data.requestId) || sameQuickAskScope(known.get(data.requestId)!, scope))) {
        deleted.set(data.requestId, scope);
      }
    }
  }
  return deleted;
}

export function quickAskRunSnapshots(
  entries: readonly SessionEntry[], live: readonly QuickAskRunSnapshot[] = [], latestOnly = true,
): QuickAskRunSnapshot[] {
  const runs = new Map<string, QuickAskRunSnapshot>();
  const items = projectSessionQuickAsks(entries);
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const data = entry.data as Partial<QuickAskRunSnapshot> | undefined;
    if (entry.customType === QUICK_ASK_RUN && data?.id && data.threadId && data.branchId && data.status) {
      const previous = runs.get(data.id);
      const admitted = (entry.data as { nativeEntries?: SessionEntry[] }).nativeEntries;
      runs.set(data.id, { question: "", images: [], answer: "", thinking: "", createdAt: 0, revision: 0,
        ...previous, ...data,
        // Attachments live once, in the admitted user message; records written earlier also carry a copy.
        ...(data.images === undefined && admitted ? { images: nativeUserImages(admitted) } : {}),
      } as QuickAskRunSnapshot);
    }
  }
  for (const item of items) if (item.data.runId) {
    const run = runs.get(item.data.runId);
    if (run) runs.set(run.id, { ...run, status: "completed", answer: item.data.answer, thinking: item.data.thinking ?? "",
      revision: item.data.revision ?? run.revision + 1, entry: item });
  }
  for (const run of runs.values()) if (run.status === "running") { run.status = "interrupted"; run.error = "Reader runtime ended before this Side Ask finished"; }
  for (const run of live) runs.set(run.id, run);
  for (const id of quickAskDeletedRuns(entries).keys()) runs.delete(id);
  if (!latestOnly) return [...runs.values()];
  const latest = new Map<string, QuickAskRunSnapshot>();
  for (const run of runs.values()) latest.set(quickAskScopeKey(run), run);
  return [...latest.values()];
}

/** A stored item as the history list sends it: display fields only; native SDK entries stay on the host as the replay and fork source. */
export function quickAskListEntry(entry: QuickAskEntry): QuickAskEntry {
  const { nativeEntries: _native, ...data } = entry.data;
  return { ...entry, data };
}

/** A run for the history list. The observer fills its entry's attachments from the run itself, so that copy and the native entries stay home. */
export function quickAskListRun(run: QuickAskRunSnapshot): QuickAskRunSnapshot {
  const { nativeEntries: _native, ...rest } = run as QuickAskRunSnapshot & { nativeEntries?: unknown };
  if (!rest.entry) return rest;
  const { nativeEntries: _entryNative, images: _entryImages, ...data } = rest.entry.data;
  return { ...rest, entry: { ...rest.entry, data } };
}
