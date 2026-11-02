import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireStateWriteLock, assertNoLegacyStateWriterLock } from "../bin/state-write-lock.cjs";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { AgentEventLike } from "./agent-event-wire";
import { LIVE_EVENT_MAX_EVENT_BYTES, type LiveAgentEventRecord } from "./live-agent-events";

export const LIVE_EVENT_LEDGER_SCHEMA_VERSION = 1;
export const LIVE_EVENT_LEDGER_MAX_EVENTS = 512;
export const LIVE_EVENT_LEDGER_MAX_BYTES = 2 * 1024 * 1024;
// Physical retention has headroom so sustained streams do not rewrite the
// retained window for every new event. Public replay keeps the original bounds.
export const LIVE_EVENT_LEDGER_COMPACT_EVENTS = LIVE_EVENT_LEDGER_MAX_EVENTS + 128;
export const LIVE_EVENT_LEDGER_COMPACT_BYTES = LIVE_EVENT_LEDGER_MAX_BYTES + 64 * 1024;
const MAX_RECORD_BYTES = LIVE_EVENT_MAX_EVENT_BYTES + 4096;
const MAX_RAW_BYTES = LIVE_EVENT_LEDGER_COMPACT_BYTES + MAX_RECORD_BYTES + 1;
const MAX_WRITER_CACHE_ENTRIES = 256;
type WriterMetadata = { fingerprint: string | null; cursor: number; count: number; bytes: number };
// This is an optimization only: every writer verifies the disk fingerprint
// inside the cross-process lock before trusting allocation metadata.
const writerMetadata = new Map<string, WriterMetadata>();

function fingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function rememberWriter(path: string, metadata: WriterMetadata): WriterMetadata {
  writerMetadata.delete(path);
  writerMetadata.set(path, metadata);
  if (writerMetadata.size > MAX_WRITER_CACHE_ENTRIES) writerMetadata.delete(writerMetadata.keys().next().value!);
  return metadata;
}

function diskFingerprint(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_RAW_BYTES)) throw new Error("ledger unavailable");
    return fingerprint(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
// Health of this process's writes to the existing ledger, never an event store.
const failedWrites = new Set<string>();
// Confirmed durability and unresolved failed writes are distinct facts. A later
// successful fsync covers prior complete bytes; cursor holes remain explicit.
const confirmedCursors = new Map<string, number>();
const confirmedDirectorySync = new Set<string>();

export type DurableLiveEventRecord = LiveAgentEventRecord & {
  schemaVersion: 1;
  sessionId: string;
  deviceId: string;
  bootId: string;
  runId?: string;
  recordedAt: string;
};

function ledgerRoot(): string {
  return process.env.PI_WEB_LIVE_EVENT_STATE_ROOT?.trim()
    || join(getAgentDir(), "live-event-ledger");
}

function ledgerPath(sessionId: string, deviceId = "local"): string {
  const key = createHash("sha256").update(`${deviceId}\u0000${sessionId}`).digest("hex").slice(0, 32);
  return join(ledgerRoot(), `${key}.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLine(line: string, sessionId: string): DurableLiveEventRecord | null {
  try {
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return null;
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.schemaVersion !== LIVE_EVENT_LEDGER_SCHEMA_VERSION
      || value.sessionId !== sessionId
      || typeof value.deviceId !== "string"
      || typeof value.bootId !== "string"
      || !Number.isSafeInteger(value.cursor)
      || (value.cursor as number) < 1
      || !isRecord(value.event)
      || typeof value.recordedAt !== "string") return null;
    return value as unknown as DurableLiveEventRecord;
  } catch {
    return null;
  }
}

function retainLedgerRecords(records: DurableLiveEventRecord[]): DurableLiveEventRecord[] {
  const retained: DurableLiveEventRecord[] = [];
  let bytes = 0;
  for (let index = records.length - 1; index >= 0 && retained.length < LIVE_EVENT_LEDGER_MAX_EVENTS; index -= 1) {
    const recordBytes = Buffer.byteLength(JSON.stringify(records[index]), "utf8") + 1;
    if (recordBytes > LIVE_EVENT_LEDGER_MAX_BYTES) throw new Error("ledger record exceeds retention budget");
    if (bytes + recordBytes > LIVE_EVENT_LEDGER_MAX_BYTES) break;
    retained.push(records[index]);
    bytes += recordBytes;
  }
  return retained.reverse();
}

function readLedger(sessionId: string, deviceId: string): { records: DurableLiveEventRecord[]; metadata: WriterMetadata } {
  const path = ledgerPath(sessionId, deviceId);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], metadata: { fingerprint: null, cursor: 0, count: 0, bytes: 0 } };
    }
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_RAW_BYTES)) throw new Error("ledger unavailable");
    const size = Number(before.size);
    const buffer = Buffer.alloc(size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    const after = fstatSync(fd, { bigint: true });
    const key = fingerprint(after);
    if (key !== fingerprint(before) || diskFingerprint(path) !== key || bytes !== size
      || (text.length > 0 && !text.endsWith("\n"))) throw new Error("ledger changed or incomplete");
    const records: DurableLiveEventRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      const record = parseLine(line, sessionId);
      if (!record || record.deviceId !== deviceId || !record.bootId
        || record.cursor <= (records.at(-1)?.cursor ?? 0)) throw new Error("ledger integrity unavailable");
      records.push(record);
    }
    return { records, metadata: { fingerprint: key, cursor: records.at(-1)?.cursor ?? 0, count: records.length, bytes: size } };
  } finally { closeSync(fd); }
}

function loadWriter(sessionId: string, deviceId: string, path: string): WriterMetadata {
  const cached = writerMetadata.get(path);
  if (cached && cached.fingerprint === diskFingerprint(path)) return rememberWriter(path, cached);
  const { metadata } = readLedger(sessionId, deviceId);
  // Legitimate compaction preserves the tail. A deletion/truncation must not
  // silently reuse already allocated cursors while this writer is alive.
  if (cached && metadata.cursor < cached.cursor) throw new Error("ledger tail regressed");
  return rememberWriter(path, metadata);
}

function needsCompaction(metadata: WriterMetadata): boolean {
  return metadata.count > LIVE_EVENT_LEDGER_COMPACT_EVENTS || metadata.bytes > LIVE_EVENT_LEDGER_COMPACT_BYTES;
}

function compact(sessionId: string, deviceId: string, path: string): WriterMetadata {
  // Caller owns the same lock used for cursor allocation and append.
  const { records } = readLedger(sessionId, deviceId);
  const retained = retainLedgerRecords(records);
  const contents = retained.map((record) => JSON.stringify(record)).join("\n") + (retained.length ? "\n" : "");
  writePrivateFileAtomicSync(path, contents);
  return rememberWriter(path, { fingerprint: diskFingerprint(path), cursor: retained.at(-1)?.cursor ?? 0,
    count: retained.length, bytes: Buffer.byteLength(contents) });
}

export function appendDurableLiveEvent(input: {
  sessionId: string;
  deviceId: string;
  bootId: string;
  cursor: number;
  runId?: string | null;
  event: AgentEventLike;
}): { persisted: boolean; path: string; cursor?: number } {
  const path = ledgerPath(input.sessionId, input.deviceId);
  let release: (() => void) | undefined;
  try {
    mkdirSync(ledgerRoot(), { recursive: true, mode: 0o700 });
    // Both allocation and compaction belong to the same cross-process lock.
    // Another Reader worker can have advanced the shared session cursor.
    release = acquireStateWriteLock(path);
    assertNoLegacyStateWriterLock(path);
    // A corrupt/torn ledger must remain visible as incomplete; never compact
    // invalid lines away or restart its cursor at zero.
    let previous = loadWriter(input.sessionId, input.deviceId, path);
    if (!failedWrites.has(path)) confirmedCursors.set(path, previous.cursor);
    // Retry a previously failed compaction before allowing further growth.
    if (needsCompaction(previous)) previous = compact(input.sessionId, input.deviceId, path);
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 1) throw new Error("invalid ledger cursor");
    const cursor = Math.max(input.cursor, previous.cursor + 1);
    if (!Number.isSafeInteger(cursor)) throw new Error("ledger cursor exhausted");
    const record: DurableLiveEventRecord = {
      schemaVersion: LIVE_EVENT_LEDGER_SCHEMA_VERSION,
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      bootId: input.bootId,
      cursor,
      ...(input.runId ? { runId: input.runId } : {}),
      recordedAt: new Date().toISOString(),
      event: input.event,
    };
    const serialized = JSON.stringify(record);
    if (!input.bootId || !parseLine(serialized, input.sessionId)) throw new Error("invalid ledger record");
    const line = serialized + "\n";
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    let appended: WriterMetadata;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || (previous.fingerprint === null ? before.size !== BigInt(0) : fingerprint(before) !== previous.fingerprint)) {
        throw new Error("ledger changed before append");
      }
      appendFileSync(fd, line, { encoding: "utf8" });
      fsyncSync(fd);
      if (!confirmedDirectorySync.has(path)) {
        const directoryFd = openSync(dirname(path), "r");
        try { fsyncSync(directoryFd); }
        catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        finally { closeSync(directoryFd); }
        confirmedDirectorySync.add(path);
      }
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== before.size + BigInt(Buffer.byteLength(line)) || diskFingerprint(path) !== fingerprint(after)) {
        throw new Error("ledger changed during append");
      }
      appended = { fingerprint: fingerprint(after), cursor, count: previous.count + 1, bytes: Number(after.size) };
    } finally { closeSync(fd); }
    rememberWriter(path, appended);
    confirmedCursors.delete(path);
    failedWrites.delete(path);
    if (needsCompaction(appended)) {
      try { compact(input.sessionId, input.deviceId, path); }
      catch {
        // The event is already fsynced. A maintenance failure cannot turn that
        // committed append into a false negative or erase its watermark.
      }
    }
    return { persisted: true, path, cursor };
  } catch {
    failedWrites.add(path);
    return { persisted: false, path };
  } finally {
    try { release?.(); } catch { /* Kernel close releases ownership; durable bytes remain acknowledged. */ }
  }
}

export function readDurableLiveEventRecords(
  sessionId: string,
  options: { bootId?: string; deviceId?: string; cursor?: number } = {},
): { records: LiveAgentEventRecord[]; durableAvailable: boolean; coverageComplete: boolean;
  writeFailureObserved: boolean; path: string; latestBootId?: string; lastPersistedCursor: number | null;
  gap?: { afterCursor: number; recoverFromCursor: number } } {
  const path = ledgerPath(sessionId, options.deviceId);
  const writeFailureObserved = failedWrites.has(path);
  try {
    const disk = readLedger(sessionId, options.deviceId ?? "local");
    if (disk.metadata.cursor < (writerMetadata.get(path)?.cursor ?? 0)) throw new Error("ledger tail regressed");
    const retained = retainLedgerRecords(disk.records);
    const gapIndex = retained.findIndex((record, index) => index > 0 && record.cursor !== retained[index - 1].cursor + 1
      && (options.cursor ?? 0) < record.cursor - 1);
    const gap = gapIndex < 0 ? undefined : { afterCursor: retained[gapIndex - 1].cursor,
      recoverFromCursor: retained[gapIndex].cursor - 1 };
    const records = retained
      .filter((record) => (!options.bootId || record.bootId === options.bootId) && (!options.deviceId || record.deviceId === options.deviceId))
      .map(({ cursor, event }) => ({ cursor, event }));
    const durableAvailable = retained.length > 0;
    const prefixCovered = (retained[0]?.cursor ?? 1) <= (options.cursor ?? 0) + 1;
    return {
      records, durableAvailable, coverageComplete: durableAvailable && prefixCovered && !writeFailureObserved && !gap,
      writeFailureObserved, path,
      // A failed write cannot erase the previously confirmed prefix. Later
      // fsync re-establishes the watermark, while actual missing cursors gap.
      lastPersistedCursor: writeFailureObserved ? confirmedCursors.get(path) ?? writerMetadata.get(path)?.cursor ?? null : retained.at(-1)?.cursor ?? 0,
      latestBootId: retained.at(-1)?.bootId,
      ...(gap ? { gap } : {}),
    };
  } catch {
    return { records: [], durableAvailable: false, coverageComplete: false, writeFailureObserved, path, lastPersistedCursor: null };
  }
}

export function liveEventLedgerPath(sessionId: string, deviceId = "local"): string {
  return ledgerPath(sessionId, deviceId);
}
