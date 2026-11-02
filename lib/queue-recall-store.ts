import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { withStateFileTransaction } from "./state-file-transaction";
import { readQueuedDraftState, recalledQueuedDrafts, type QueuedDraftState } from "./queued-draft";
import { updateControlReceipt } from "./reader-control-receipts";

export type QueueRecallIdentity = { bootId: string; queueRevision: number };
export type QueueRecallResult = {
  clearedQueue: QueuedDraftState;
  queueSnapshot: QueuedDraftState;
  steering: string[];
  followUp: string[];
  [key: string]: unknown;
};
export type QueueRecallSettlement = {
  receiptId: string;
  update: Parameters<typeof updateControlReceipt>[1];
};
export type QueueRecoveryEntry = {
  operationId: string;
  status: "prepared" | "committed";
  expected: QueueRecallIdentity;
  createdAt: string;
  queue: QueuedDraftState;
};
export type QueueRecoveryCopy = QueueRecoveryEntry & { sessionId: string };

type RecallRecord = {
  schemaVersion: 1;
  sessionId: string;
  operationId: string;
  expected: QueueRecallIdentity;
  status: "prepared" | "committed" | "acknowledged" | "copy_saved";
  createdAt: string;
  acknowledgedAt?: string;
  clearedQueue?: QueuedDraftState;
  result?: QueueRecallResult;
  settlements: QueueRecallSettlement[];
  receiptsSettled: boolean;
  reservedBytes?: number;
};
// Unacknowledged/prepared payloads never expire silently. Actual disk space,
// not a lifetime byte budget, bounds new clears before SDK mutation. ACK
// removes attachment bytes but retains an anti-replay tombstone.
// A failed post-clear disk commit is recoverable in this process without
// clearing again. Cross-process prepared records remain explicitly uncertain.
const pendingCommits = new Map<string, QueueRecallResult>();

function error(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function assertExpected(expected: QueueRecallIdentity): void {
  if (!expected || typeof expected.bootId !== "string" || !expected.bootId || expected.bootId.length > 256
    || !Number.isSafeInteger(expected.queueRevision) || expected.queueRevision < 0) {
    throw error("invalid_queue_recall_operation", "Recall requires the original boot and queue revision");
  }
}
function storeRoot(): string {
  return process.env.PI_WEB_QUEUE_RECALL_ROOT?.trim() || join(getAgentDir(), "queue-recalls");
}
function sessionDirectory(sessionId: string): string {
  if (!sessionId) throw error("invalid_queue_recall_operation", "A session is required for queue recovery");
  return join(storeRoot(), createHash("sha256").update(sessionId).digest("hex"));
}
function recordName(sessionId: string, operationId: string): string {
  return `${createHash("sha256").update(JSON.stringify([sessionId, operationId])).digest("hex")}.json`;
}
function pathFor(sessionId: string, operationId: string): string {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw error("invalid_queue_recall_operation", "A bounded queue recall operation ID is required");
  const name = recordName(sessionId, operationId);
  // Existing flat records keep their original authority and tombstones. Never
  // copy/move them while an older writer or same-process pending commit may
  // still address that path. All new operations have a session-owned directory.
  const legacy = join(storeRoot(), name);
  const scoped = join(sessionDirectory(sessionId), name);
  if (existsSync(legacy)) {
    if (existsSync(scoped)) throw error("queue_recovery_conflict", "Two saved records claim the same recovery operation; neither will be overwritten");
    return legacy;
  }
  return scoped;
}
function read(path: string): RecallRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as RecallRecord;
    if (record.schemaVersion !== 1 || !["prepared", "committed", "acknowledged", "copy_saved"].includes(record.status)
      || !Array.isArray(record.settlements) || typeof record.receiptsSettled !== "boolean"
      || record.settlements.some(entry => !entry || typeof entry.receiptId !== "string" || !entry.receiptId || entry.update?.outcome !== "aborted")) throw new Error("Invalid queue recall record");
    if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.operationId !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(record.operationId) || typeof record.createdAt !== "string") throw new Error("Invalid queue recall identity");
    assertExpected(record.expected);
    if (record.status === "prepared") recalledQueuedDrafts(record.clearedQueue);
    if (record.status === "committed") {
      if (!record.result || !readQueuedDraftState(record.result.queueSnapshot)) throw new Error("Invalid committed queue recall result");
      recalledQueuedDrafts(record.result.clearedQueue);
    }
    const captured = record.status === "prepared" ? record.clearedQueue : record.result?.clearedQueue;
    if (captured && (captured.bootId !== record.expected.bootId || captured.queueRevision !== record.expected.queueRevision)) throw new Error("Recovery payload does not match its captured queue identity");
    return record;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure;
  }
}
function validate(record: RecallRecord, sessionId: string, operationId: string, expected: QueueRecallIdentity): void {
  if (record.sessionId !== sessionId || record.operationId !== operationId
    || record.expected.bootId !== expected.bootId || record.expected.queueRevision !== expected.queueRevision) {
    throw error("queue_recall_operation_conflict", "This recall operation belongs to a different queue identity");
  }
}
function write(path: string, record: RecallRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify(record));
  // Both the payload and a newly created session directory must be durable
  // before prepare returns permission to clear the SDK queue.
  for (const parent of new Set([dirname(path), storeRoot()])) {
    const directory = openSync(parent, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
function transaction<T>(_path: string, work: () => T): T {
  // One kernel lock also serializes store-capacity reservations across processes.
  return withStateFileTransaction(join(storeRoot(), ".store"), work);
}
function assertCapacity(_path: string, record: RecallRecord): void {
  const directory = storeRoot();
  const space = statfsSync(directory);
  const available = space.bavail * space.bsize;
  let outstandingReservations = 0;
  const account = (path: string) => {
    const bytes = statSync(path).size;
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as { reservedBytes?: number; status?: string };
      if (existing.reservedBytes === undefined && !["committed", "acknowledged", "copy_saved"].includes(existing.status ?? "")) throw new Error("Missing reservation state");
      const reservation = existing.reservedBytes ?? 0;
      if (!Number.isFinite(reservation) || reservation < 0) throw new Error("Invalid reservation");
      // Prepared reservations are derived from this payload's size. A
      // corrupted number must not reserve arbitrary space across sessions.
      outstandingReservations += Math.max(0, Math.min(reservation, bytes * 2 + 64 * 1024) - bytes);
    } catch {
      // A damaged payload cannot block unrelated sessions. Conservatively
      // reserve its full atomic rewrite; discovery reports the corruption.
      outstandingReservations += bytes + 64 * 1024;
    }
  };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) account(join(directory, entry.name));
    if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
      for (const name of readdirSync(join(directory, entry.name))) if (/^[a-f0-9]{64}\.json$/.test(name)) account(join(directory, entry.name, name));
    }
  }
  if (available < outstandingReservations + (record.reservedBytes ?? 0)) {
    throw error("queue_recall_store_full", "The server has insufficient free disk space for a recoverable queue copy. Save and confirm older recovery copies or free server space; the queue is unchanged.");
  }
}

/** Read-only replay, except for finishing a known same-process commit failure. */
export function readQueueRecallResult(sessionId: string, operationId: string, expected: QueueRecallIdentity): QueueRecallResult | null {
  assertExpected(expected);
  const path = pathFor(sessionId, operationId);
  const record = read(path);
  if (!record) return null;
  validate(record, sessionId, operationId, expected);
  if (record.status === "acknowledged" || record.status === "copy_saved") throw error("queue_recall_acknowledged", "This recovery copy was confirmed as saved. Its server attachment copy was removed; this operation will not clear again.");
  if (record.status === "committed") return record.result!;
  const pending = pendingCommits.get(path);
  if (pending) { commitQueueRecall(sessionId, operationId, expected, pending); return pending; }
  throw error("queue_recall_pending", "This recall has a durable prepared record but no confirmed clear result. The captured attachments are retained; do not clear again until the original operation is reconciled.");
}

/** Exact receipt identities are frozen before clear, not found again by text. */
export async function settleQueueRecallReceipts(sessionId: string, operationId: string, expected: QueueRecallIdentity, beforeSettle?: (settlements: QueueRecallSettlement[]) => void): Promise<string[]> {
  assertExpected(expected);
  const path = pathFor(sessionId, operationId);
  const record = read(path);
  if (!record) throw error("queue_recall_pending", "The recall recovery record is missing");
  validate(record, sessionId, operationId, expected);
  if (record.status === "prepared" || record.status === "copy_saved") throw error("queue_recall_pending", "The original clear is not confirmed; its receipts cannot be settled");
  beforeSettle?.(record.settlements);
  if (!record.receiptsSettled) {
    for (const settlement of record.settlements) {
      const receipt = await updateControlReceipt(settlement.receiptId, settlement.update);
      if (!receipt || receipt.outcome !== "aborted" || receipt.error?.code !== "queued_control_cleared") {
        throw error("queue_recall_receipts_pending", "The cleared control receipt is missing or has a conflicting terminal result; attachments remain recoverable until settlement is reconciled");
      }
    }
    transaction(path, () => {
      const latest = read(path)!;
      validate(latest, sessionId, operationId, expected);
      write(path, { ...latest, receiptsSettled: true });
    });
  }
  return record.settlements.map(entry => entry.receiptId);
}

/** Replaying a committed clear also finishes its original receipt settlements. */
export async function replayQueueRecall(sessionId: string, operationId: string, expected: QueueRecallIdentity): Promise<QueueRecallResult | null> {
  const result = readQueueRecallResult(sessionId, operationId, expected);
  if (result) await settleQueueRecallReceipts(sessionId, operationId, expected);
  return result;
}

/** Call only after CAS validation, immediately before the synchronous SDK clear. */
export function prepareQueueRecall(sessionId: string, operationId: string, expected: QueueRecallIdentity, clearedQueue: QueuedDraftState, settlements: QueueRecallSettlement[] = []): QueueRecallResult | null {
  assertExpected(expected);
  const path = pathFor(sessionId, operationId);
  return transaction(path, () => {
    const existing = read(path);
    if (existing) {
      validate(existing, sessionId, operationId, expected);
      if (existing.status === "committed") return existing.result!;
      throw error("queue_recall_pending", "The original recall is pending or acknowledged; it must not clear the queue again");
    }
    recalledQueuedDrafts(clearedQueue);
    if (clearedQueue.bootId !== expected.bootId || clearedQueue.queueRevision !== expected.queueRevision) throw error("queue_recall_operation_conflict", "The captured queue does not match the recall identity");
    const record: RecallRecord = { schemaVersion: 1, sessionId, operationId, expected, status: "prepared", createdAt: new Date().toISOString(), clearedQueue, settlements, receiptsSettled: settlements.length === 0 };
    record.reservedBytes = Buffer.byteLength(JSON.stringify(record)) * 2 + 64 * 1024;
    assertCapacity(path, record);
    write(path, record);
    return null;
  });
}

/** Commit the full response before any await or receipt-settlement work. */
export function commitQueueRecall(sessionId: string, operationId: string, expected: QueueRecallIdentity, result: QueueRecallResult): void {
  assertExpected(expected);
  const path = pathFor(sessionId, operationId);
  pendingCommits.set(path, result);
  transaction(path, () => {
    const record = read(path);
    if (!record) throw error("queue_recall_pending", "The prepared recall record is missing; the clear result remains pending");
    validate(record, sessionId, operationId, expected);
    if (record.status === "prepared") {
      const metadata = { ...record };
      delete metadata.clearedQueue;
      delete metadata.reservedBytes;
      write(path, { ...metadata, status: "committed", result });
    }
  });
  pendingCommits.delete(path);
}

/** Only the caller that durably restored the draft may acknowledge its payload. */
export async function acknowledgeQueueRecall(sessionId: string, operationId: string, expected: QueueRecallIdentity): Promise<string[]> {
  const receiptIds = await settleQueueRecallReceipts(sessionId, operationId, expected);
  const path = pathFor(sessionId, operationId);
  transaction(path, () => {
    const record = read(path)!;
    validate(record, sessionId, operationId, expected);
    if (record.status === "acknowledged") return;
    const metadata = { ...record };
    delete metadata.result;
    delete metadata.clearedQueue;
    write(path, { ...metadata, status: "acknowledged", acknowledgedAt: new Date().toISOString() });
  });
  pendingCommits.delete(path);
  return receiptIds;
}


function recoveryEntry(record: RecallRecord, includeImages: boolean): QueueRecoveryEntry | null {
  if (record.status !== "prepared" && record.status !== "committed") return null;
  const captured = record.status === "prepared" ? record.clearedQueue! : record.result!.clearedQueue;
  const summarize = (items: QueuedDraftState["steering"]) => items.map(({ images, ...item }) => ({ ...item, ...(includeImages && images ? { images: images.map(image => ({ ...image })) } : {}) }));
  return { operationId: record.operationId, status: record.status, expected: { ...record.expected }, createdAt: record.createdAt,
    queue: { ...captured, steering: summarize(captured.steering), followUp: summarize(captured.followUp) } };
}

/** Session-owned files are selected before parsing. Legacy records have no
 * filename ownership, so unreadable legacy bytes are reported as unassigned
 * warnings, never treated as proof that this session has an empty inbox. */
export function listQueueRecoveries(sessionId: string): { recoveries: QueueRecoveryEntry[]; warnings: string[] } {
  const recoveries: QueueRecoveryEntry[] = [];
  const warnings: string[] = [];
  const names = (directory: string) => {
    try { return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return []; throw failure; }
  };
  const append = (path: string, name: string) => {
    const record = read(path);
    if (!record) return;
    if (record.sessionId !== sessionId || name !== recordName(sessionId, record.operationId)) throw new Error("Recovery record ownership does not match its path");
    // Reject two authorities for an operation instead of offering duplicates.
    pathFor(sessionId, record.operationId);
    const entry = recoveryEntry(record, false);
    if (entry) recoveries.push(entry);
  };
  for (const name of names(sessionDirectory(sessionId))) {
    try { append(join(sessionDirectory(sessionId), name), name); }
    catch { warnings.push(`A saved recovery record for this session is corrupt or unreadable (${name}). Its bytes are retained; recovery may be incomplete.`); }
  }
  for (const name of names(storeRoot())) {
    const path = join(storeRoot(), name);
    let owner: unknown;
    try { owner = JSON.parse(readFileSync(path, "utf8"))?.sessionId; }
    catch { /* Ownership cannot be inferred from a legacy pair hash. */ }
    if (typeof owner !== "string" || !owner) {
      warnings.push(`A legacy recovery record is corrupt or unreadable and its session is unknown (${name}). Its bytes are retained; older recovery copies may be incomplete.`);
      continue;
    }
    if (owner !== sessionId) continue;
    try { append(path, name); }
    catch { warnings.push(`A saved legacy recovery record for this session is corrupt or unreadable (${name}). Its bytes are retained; recovery may be incomplete.`); }
  }
  recoveries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
  return { recoveries, warnings };
}

/** Viewing/exporting a prepared copy makes NO claim that SDK clear committed. */
export function readQueueRecoveryCopy(sessionId: string, operationId: string): QueueRecoveryCopy {
  const record = read(pathFor(sessionId, operationId));
  if (!record || record.sessionId !== sessionId) throw error("queue_recovery_missing", "This recovery copy is not available for this session");
  if (record.operationId !== operationId) throw error("queue_recovery_conflict", "The saved recovery identity does not match this operation");
  const entry = recoveryEntry(record, true);
  if (!entry) throw error("queue_recall_acknowledged", "This recovery copy has already been confirmed as saved");
  return { ...entry, sessionId };
}

/** Explicit user confirmation can retire an UNKNOWN copy without clearing,
 * replaying, or inventing an aborted control receipt. The uncertainty survives
 * in the tombstone, so this operation can never clear the original queue again. */
export async function confirmQueueRecoveryCopySaved(sessionId: string, operationId: string, expected: QueueRecallIdentity): Promise<void> {
  assertExpected(expected);
  const path = pathFor(sessionId, operationId);
  const record = read(path);
  if (!record) throw error("queue_recovery_missing", "The recovery copy is missing");
  validate(record, sessionId, operationId, expected);
  if (record.status === "committed" || record.status === "acknowledged") {
    await acknowledgeQueueRecall(sessionId, operationId, expected);
    return;
  }
  transaction(path, () => {
    const latest = read(path)!;
    validate(latest, sessionId, operationId, expected);
    if (latest.status === "copy_saved") return;
    // A concurrent commit must use normal ACK and its receipt settlements.
    if (latest.status !== "prepared") throw error("queue_recovery_changed", "The recovery status changed; refresh and confirm the saved copy again");
    const metadata = { ...latest };
    delete metadata.clearedQueue;
    delete metadata.reservedBytes;
    write(path, { ...metadata, status: "copy_saved", acknowledgedAt: new Date().toISOString() });
  });
  pendingCommits.delete(path);
}

/** A self-contained, script-free copy that opens offline with all attachments. */
export function queueRecoveryHtml(copy: QueueRecoveryCopy): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
  const entries = [...copy.queue.steering.map(item => ({ ...item, kind: "steering" })), ...copy.queue.followUp.map(item => ({ ...item, kind: "follow-up" }))];
  const body = entries.map(item => `<section><h2>${escape(item.kind)} · ${escape(item.itemId)}</h2><pre>${escape(item.text)}</pre>${(item.images ?? []).map((image, index) => `<figure><img alt="Attachment ${index + 1}" src="data:${escape(image.mimeType)};base64,${escape(image.data)}"><figcaption>Attachment ${index + 1} · ${escape(image.mimeType)}</figcaption></figure>`).join("")}</section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Reader queue recovery copy</title><style>body{font:16px system-ui;max-width:900px;margin:32px auto;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%}section{border-top:1px solid #aaa;margin-top:24px}small{overflow-wrap:anywhere}</style></head><body><h1>Reader queue recovery copy</h1><p>${copy.status === "prepared" ? "Clear outcome unknown. These messages may still be queued or may already have run. This copy does not send or clear anything." : "These messages were removed from the queue. This copy does not send anything."}</p><small>Session: ${escape(copy.sessionId)}<br>Operation: ${escape(copy.operationId)}<br>Boot: ${escape(copy.expected.bootId)} · Queue revision: ${copy.expected.queueRevision}</small>${body}</body></html>`;
}
