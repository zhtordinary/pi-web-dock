import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { withStateFileTransaction } from "./state-file-transaction";
import { redactLiveValue } from "./live-agent-events";
import { validateSessionMutationCommand } from "./session-mutation-command";
import { isReaderCreateFailureDiagnostic, type ReaderCreateFailureDiagnostic } from "./reader-create-diagnostics";

export type ReaderControlOutcome =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "unknown"
  | "conflict";

export type ReaderControlReceipt = {
  schemaVersion: 1;
  receiptId: string;
  deviceId: string;
  sessionId: string;
  operation: string;
  idempotencyKey: string;
  requestFingerprint: string;
  clientRequestFingerprint?: string;
  cwd: string;
  outcome: ReaderControlOutcome;
  createdAt: string;
  acceptedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  runId?: string;
  bootId?: string;
  revision?: string;
  response?: unknown;
  error?: { code: string; message: string; diagnostic?: ReaderCreateFailureDiagnostic };
  nextAction?: string;
  targetStopped?: boolean;
  mutationCommand?: { operationId: string; deviceId: string; sessionId: string; op: "rename" | "archive" | "unarchive" | "delete"; name?: string; force: boolean };
  recoveryReviewedAt?: string;
  createdSessionId?: string;
  createdSessionBinding?: { deviceId: string; sessionId: string; cwd: string; toolNames?: string[]; strictToolAllowlist: boolean };
  audit?: { kind: "configuration" | "creation"; area?: string; scope?: "global" | "project"; callerRef: string; authority: "reader-owner-policy"; targetRef: string; confirmationReasonRef: string };
};

type ReceiptStore = {
  schemaVersion: 1;
  receipts: Record<string, ReaderControlReceipt>;
};

const KEY_MAX = 200;
const FINGERPRINT_MAX = 128;
const TERMINAL_OUTCOMES = new Set<ReaderControlOutcome>(["completed", "failed", "aborted", "unknown", "conflict"]);
const RECEIPT_OUTCOMES = new Set<ReaderControlOutcome>([
  "accepted",
  "running",
  "completed",
  "failed",
  "aborted",
  "unknown",
  "conflict",
]);

function storeRoot(): string {
  return process.env.PI_WEB_CONTROL_RECEIPT_ROOT?.trim()
    || join(getAgentDir(), "session-control-receipts");
}

function storePath(): string {
  return join(storeRoot(), "receipts.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredReceiptString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Reader control receipt store has an invalid ${field}`);
  }
  return result;
}

function normalizeStore(value: unknown): ReceiptStore {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.receipts)) {
    throw new Error("Reader control receipt store schema is invalid");
  }
  const receipts: Record<string, ReaderControlReceipt> = {};
  for (const [key, valueForKey] of Object.entries(value.receipts)) {
    if (!isRecord(valueForKey) || valueForKey.schemaVersion !== 1) {
      throw new Error(`Reader control receipt store entry ${key} is invalid`);
    }
    const receipt = valueForKey as Record<string, unknown>;
    const deviceId = requiredReceiptString(receipt, "deviceId");
    const sessionId = requiredReceiptString(receipt, "sessionId");
    const operation = requiredReceiptString(receipt, "operation");
    const idempotencyKey = requiredReceiptString(receipt, "idempotencyKey");
    const requestFingerprint = requiredReceiptString(receipt, "requestFingerprint");
    const receiptId = requiredReceiptString(receipt, "receiptId");
    const cwd = requiredReceiptString(receipt, "cwd");
    const outcome = receipt.outcome;
    if (typeof outcome !== "string" || !RECEIPT_OUTCOMES.has(outcome as ReaderControlOutcome)) {
      throw new Error(`Reader control receipt store entry ${key} has an invalid outcome`);
    }
    for (const field of ["createdAt", "acceptedAt", "updatedAt"]) requiredReceiptString(receipt, field);
    if (receipt.clientRequestFingerprint !== undefined && typeof receipt.clientRequestFingerprint !== "string") {
      throw new Error(`Reader control receipt store entry ${key} has an invalid clientRequestFingerprint`);
    }
    for (const field of ["startedAt", "completedAt", "runId", "bootId", "revision", "nextAction", "recoveryReviewedAt"]) {
      if (receipt[field] !== undefined && typeof receipt[field] !== "string") {
        throw new Error(`Reader control receipt store entry ${key} has an invalid ${field}`);
      }
    }
    if (receipt.mutationCommand !== undefined) {
      const command = validateSessionMutationCommand(receipt.mutationCommand);
      if (operation !== "session_mutation" || command.operationId !== idempotencyKey || command.deviceId !== deviceId || command.sessionId !== sessionId
        || controlRequestFingerprint(command) !== requestFingerprint) throw new Error("Reader control receipt has an invalid mutation binding");
    }
    if (receipt.targetStopped !== undefined && typeof receipt.targetStopped !== "boolean") {
      throw new Error(`Reader control receipt store entry ${key} has an invalid targetStopped`);
    }
    if (receipt.error !== undefined) {
      if (!isRecord(receipt.error)
        || typeof receipt.error.code !== "string"
        || receipt.error.code.length === 0
        || typeof receipt.error.message !== "string") {
        throw new Error(`Reader control receipt store entry ${key} has an invalid error`);
      }
      if (receipt.error.diagnostic !== undefined && !isReaderCreateFailureDiagnostic(receipt.error.diagnostic, receiptId)) {
        throw new Error(`Reader control receipt store entry ${key} has an invalid failure diagnostic`);
      }
    }
    if (receipt.createdSessionId !== undefined && (typeof receipt.createdSessionId !== "string" || !receipt.createdSessionId || receipt.operation !== "create_session" || receipt.sessionId !== "new")) {
      throw new Error("Reader control receipt has an invalid created session identity");
    }
    if (receipt.createdSessionBinding !== undefined) {
      const binding = receipt.createdSessionBinding;
      if (!isRecord(binding) || binding.deviceId !== deviceId || binding.sessionId !== receipt.createdSessionId || typeof binding.cwd !== "string" || !binding.cwd || typeof binding.strictToolAllowlist !== "boolean"
        || (binding.toolNames !== undefined && (!Array.isArray(binding.toolNames) || binding.toolNames.some((name) => typeof name !== "string")))) throw new Error("Reader control receipt has an invalid created session binding");
    }
    if (operation === "create_session" && outcome === "completed" && (!receipt.createdSessionId || !receipt.createdSessionBinding)) throw new Error("Completed creation receipt is missing its binding");
    if (receipt.audit !== undefined) {
      const audit = receipt.audit;
      if (!isRecord(audit) || !["configuration", "creation"].includes(String(audit.kind)) || audit.authority !== "reader-owner-policy"
        || (audit.kind === "configuration" && (!["global", "project"].includes(String(audit.scope)) || typeof audit.area !== "string"))
        || (audit.kind === "creation" && operation !== "create_session")
        || [audit.callerRef, audit.targetRef, audit.confirmationReasonRef].some((v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))) {
        throw new Error("Reader control receipt has an invalid configuration audit");
      }
    }
    const expectedKey = receiptKey({ deviceId, sessionId, operation, idempotencyKey });
    if (key !== expectedKey || typeof receiptId !== "string" || typeof cwd !== "string" || typeof requestFingerprint !== "string") {
      throw new Error(`Reader control receipt store entry ${key} has an invalid identity`);
    }
    receipts[key] = valueForKey as unknown as ReaderControlReceipt;
  }
  return { schemaVersion: 1, receipts };
}

function physicalStoreDirectory(): string {
  try { return dirname(realpathSync(storePath())); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return storeRoot(); }
}
function databasePath(): string { return join(physicalStoreDirectory(), "receipts.sqlite"); }
const MIGRATION_MARKER = { schemaVersion: 2, storage: "receipts.sqlite" };

function legacyBytes(): string {
  return existsSync(storePath()) ? readFileSync(storePath(), "utf8") : "";
}
function isMigrationMarker(raw: string): boolean {
  if (!raw) return false;
  const value = JSON.parse(raw);
  return value?.schemaVersion === 2 && value?.storage === "receipts.sqlite";
}
function decodeRow(row: Record<string, unknown> | undefined): ReaderControlReceipt | null {
  if (!row) return null;
  const key = String(row.key);
  return normalizeStore({ schemaVersion: 1, receipts: { [key]: JSON.parse(String(row.json)) } }).receipts[key];
}
function writeReceipt(db: DatabaseSync, receipt: ReaderControlReceipt): void {
  db.prepare(`INSERT INTO receipts(key, receipt_id, device_id, session_id, operation, idempotency_key, reviewed, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET reviewed=excluded.reviewed, json=excluded.json`)
    .run(receiptKey(receipt), receipt.receiptId, receipt.deviceId, receipt.sessionId, receipt.operation,
      receipt.idempotencyKey, receipt.recoveryReviewedAt ? 1 : 0, JSON.stringify(receipt));
}

/** Migration is restartable. The old writer sees schemaVersion=2 and fails
 * closed, rather than creating a second authoritative receipt store. */
function openWriter(): DatabaseSync {
  mkdirSync(storeRoot(), { recursive: true, mode: 0o700 });
  const raw = legacyBytes();
  const migrated = isMigrationMarker(raw);
  if (migrated && !existsSync(databasePath())) throw new Error("Receipt database is missing after migration");
  const legacy = migrated ? null : raw ? normalizeStore(JSON.parse(raw)) : { schemaVersion: 1 as const, receipts: {} };
  const db = new DatabaseSync(databasePath());
  try {
    chmodSync(databasePath(), 0o600);
    db.exec(`PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, receipt_id TEXT UNIQUE NOT NULL,
        device_id TEXT NOT NULL, session_id TEXT NOT NULL, operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipt_lookup ON receipts(device_id, session_id, operation, idempotency_key);
      CREATE INDEX IF NOT EXISTS receipt_recovery ON receipts(device_id, operation, reviewed, receipt_id);
      CREATE UNIQUE INDEX IF NOT EXISTS mutation_identity ON receipts(idempotency_key) WHERE operation='session_mutation';`);
    const imported = db.prepare("SELECT value FROM metadata WHERE key='legacy_hash'").get();
    if (migrated) {
      if (!imported) throw new Error("Receipt migration is incomplete");
    } else {
      const hash = controlRequestFingerprint(raw);
      if (imported && imported.value !== hash) throw new Error("Legacy receipts changed during migration; inspect both stores before continuing");
      if (!imported) {
        // Keep the original complete JSON for a quiescent, explicit rollback.
        if (raw) writePrivateFileAtomicSync(join(physicalStoreDirectory(), "receipts.legacy.json"), raw);
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const receipt of Object.values(legacy!.receipts)) writeReceipt(db, receipt);
          db.prepare("INSERT INTO metadata(key,value) VALUES ('legacy_hash', ?)").run(hash);
          db.exec("COMMIT");
        } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
      }
      // COMMIT is durable before the pointer switches. A crash in between is
      // replayed using the hash, without overwriting newer indexed receipts.
      writePrivateFileAtomicSync(storePath(), JSON.stringify(MIGRATION_MARKER));
    }
    // A marker rename may have succeeded before directory fsync failed. Keep
    // that recovery obligation in SQLite, across processes, until the filename
    // is confirmed durable. An existing marker alone is not sufficient.
    if (!db.prepare("SELECT value FROM metadata WHERE key='marker_durable'").get()) {
      const directoryFd = openSync(physicalStoreDirectory(), "r");
      try { fsyncSync(directoryFd); }
      catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      finally { closeSync(directoryFd); }
      db.prepare("INSERT INTO metadata(key,value) VALUES ('marker_durable','1')").run();
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

async function withStore<T>(operation: (db: DatabaseSync) => T): Promise<T> {
  return withStateFileTransaction(storePath(), () => {
    const db = openWriter();
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = operation(db);
      db.exec("COMMIT");
      return result;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    finally { db.close(); }
  });
}

function receiptKey(input: { deviceId: string; sessionId: string; operation: string; idempotencyKey: string }): string {
  return [input.deviceId, input.sessionId, input.operation, input.idempotencyKey].join("\u0000");
}

/** Queries never migrate or create storage. SQL lookups are read-only. */
function readRows(where: string, values: string[], limit?: number): ReaderControlReceipt[] {
  const raw = legacyBytes();
  if (!raw) return [];
  if (!isMigrationMarker(raw)) {
    return Object.values(normalizeStore(JSON.parse(raw)).receipts);
  }
  if (!existsSync(databasePath())) throw new Error("Receipt database is missing after migration");
  const db = new DatabaseSync(databasePath(), { readOnly: true });
  try {
    if (!db.prepare("SELECT value FROM metadata WHERE key='legacy_hash'").get()) throw new Error("Receipt migration is incomplete");
    return db.prepare(`SELECT key,json FROM receipts WHERE ${where} ORDER BY receipt_id${limit ? ` LIMIT ${limit}` : ""}`)
      .all(...values).map(row => decodeRow(row)!);
  } finally { db.close(); }
}

export function validateControlIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > KEY_MAX || /[\0\r\n]/.test(value)) {
    throw new Error("idempotencyKey must be 8-200 characters without control characters");
  }
  return value;
}

export function validateControlFingerprint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > FINGERPRINT_MAX || /[\0\r\n]/.test(value)) {
    throw new Error("requestFingerprint is invalid");
  }
  return value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function controlRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export type ReaderControlReservation = {
  receipt: ReaderControlReceipt;
  replayed: boolean;
  conflict: boolean;
};

export async function reserveControlReceipt(input: {
  deviceId: string;
  sessionId: string;
  operation: string;
  idempotencyKey: string;
  requestFingerprint: string;
  clientRequestFingerprint?: string;
  cwd: string;
  bootId?: string;
  revision?: string;
  audit?: ReaderControlReceipt["audit"];
  mutationCommand?: ReaderControlReceipt["mutationCommand"];
}): Promise<ReaderControlReservation> {
  const now = new Date().toISOString();
  return withStore((db) => {
    const key = receiptKey(input);
    const existing = decodeRow(db.prepare("SELECT key,json FROM receipts WHERE key=?").get(key)) ?? (input.operation === "session_mutation"
      ? decodeRow(db.prepare("SELECT key,json FROM receipts WHERE operation='session_mutation' AND idempotency_key=?").get(input.idempotencyKey))
      : null);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        return {
          replayed: false,
          conflict: true,
          receipt: {
            ...existing,
            outcome: "conflict",
            error: { code: "idempotency_conflict", message: "idempotencyKey was already used with a different request" },
            nextAction: "inspect_existing_receipt",
          },
        };
      }
      // A repeated request in the same live runtime is a normal replay. Only
      // turn an in-flight reservation into unknown when its boot identity no
      // longer matches the current owner, which is the observable crash/restart
      // boundary for Reader.
      if (existing.outcome === "accepted" || existing.outcome === "running") {
        // A duplicate mutation can arrive at another live server worker. It
        // observes the reservation without terminating its original writer;
        // read projections report unknown across boots until a result arrives.
        if (input.operation === "session_mutation") return { receipt: existing, replayed: true, conflict: false };
        if (existing.bootId && input.bootId && existing.bootId === input.bootId) {
          return { receipt: existing, replayed: true, conflict: false };
        }
        const recovered: ReaderControlReceipt = {
          ...existing,
          outcome: "unknown",
          updatedAt: now,
          nextAction: "inspect_before_retry",
          error: { code: "prior_attempt_unknown", message: "The prior Reader process stopped before recording a terminal result" },
        };
        writeReceipt(db, recovered);
        return { receipt: recovered, replayed: true, conflict: false };
      }
      return { receipt: existing, replayed: true, conflict: false };
    }
    const receipt: ReaderControlReceipt = {
      schemaVersion: 1,
      receiptId: randomUUID(),
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      ...(input.clientRequestFingerprint ? { clientRequestFingerprint: input.clientRequestFingerprint } : {}),
      cwd: input.cwd,
      outcome: "accepted",
      createdAt: now,
      acceptedAt: now,
      updatedAt: now,
      ...(input.bootId ? { bootId: input.bootId } : {}),
      ...(input.revision ? { revision: input.revision } : {}),
      ...(input.audit ? { audit: input.audit } : {}),
      ...(input.mutationCommand ? { mutationCommand: input.mutationCommand } : {}),
      nextAction: "observe_receipt_or_runtime",
    };
    writeReceipt(db, receipt);
    return { receipt, replayed: false, conflict: false };
  });
}

export async function updateControlReceipt(
  receiptId: string,
  update: Partial<Pick<ReaderControlReceipt, "outcome" | "startedAt" | "completedAt" | "updatedAt" | "runId" | "bootId" | "revision" | "response" | "error" | "nextAction" | "targetStopped" | "createdSessionId" | "createdSessionBinding" | "recoveryReviewedAt">>,
): Promise<ReaderControlReceipt | null> {
  return withStore((db) => {
    const receipt = decodeRow(db.prepare("SELECT key,json FROM receipts WHERE receipt_id=?").get(receiptId));
    if (!receipt) return null;
    // A fast POST acknowledgement can race the asynchronous agent lifecycle.
    // Never let its provisional running update overwrite a terminal fact that
    // the runtime already recorded.
    if (update.outcome && TERMINAL_OUTCOMES.has(receipt.outcome) && update.outcome !== receipt.outcome) {
      return receipt;
    }
    const now = new Date().toISOString();
    const next: ReaderControlReceipt = { ...receipt, ...update, updatedAt: update.updatedAt ?? now };
    writeReceipt(db, next);
    return next;
  });
}

export async function readControlReceipt(input: {
  deviceId: string;
  sessionId: string;
  receiptId?: string;
  idempotencyKey?: string;
  operation?: string;
}): Promise<ReaderControlReceipt | null> {
  const clauses = ["device_id=?", "session_id=?"];
  const values = [input.deviceId, input.sessionId];
  for (const [column, value] of [["operation", input.operation], ["receipt_id", input.receiptId], ["idempotency_key", input.idempotencyKey]]) {
    if (value) { clauses.push(`${column}=?`); values.push(value); }
  }
  return readRows(clauses.join(" AND "), values).find(receipt => receipt.deviceId === input.deviceId && receipt.sessionId === input.sessionId
    && (!input.operation || receipt.operation === input.operation) && (!input.receiptId || receipt.receiptId === input.receiptId)
    && (!input.idempotencyKey || receipt.idempotencyKey === input.idempotencyKey)) ?? null;
}

export async function listMutationControlReceipts(deviceId: string, after = "", limit = 100): Promise<ReaderControlReceipt[]> {
  const count = Math.max(1, Math.min(100, limit));
  return readRows("device_id=? AND operation='session_mutation' AND reviewed=0 AND receipt_id>?", [deviceId, after], count)
    .filter(receipt => receipt.deviceId === deviceId && receipt.operation === "session_mutation" && !receipt.recoveryReviewedAt && receipt.receiptId > after)
    .sort((a, b) => a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0).slice(0, count);
}

export function controlReceiptDatabasePath(): string { return databasePath(); }

export function controlReceiptStorePath(): string {
  return storePath();
}

/** Public control receipts expose references, not raw idempotency keys/paths. */
export function publicControlReceipt(receipt: ReaderControlReceipt) {
  const { idempotencyKey, cwd, createdSessionBinding, clientRequestFingerprint, mutationCommand: _mutationCommand, error, response, ...safe } = receipt;
  void _mutationCommand;
  return { ...safe, requestFingerprint: /^[a-f0-9]{64}$/.test(safe.requestFingerprint) ? safe.requestFingerprint : controlRequestFingerprint(safe.requestFingerprint),
    idempotencyKeyRef: controlRequestFingerprint(idempotencyKey), cwdRef: controlRequestFingerprint(cwd),
    ...(clientRequestFingerprint ? { clientRequestFingerprintRef: controlRequestFingerprint(clientRequestFingerprint) } : {}),
    ...(error ? { error: redactLiveValue(error) } : {}),
    ...(response === undefined ? {} : { response: redactLiveValue(response) }),
    ...(createdSessionBinding ? { createdSessionBinding: (() => {
      const { cwd: bindingCwd, ...binding } = createdSessionBinding;
      return { ...binding, cwdRef: controlRequestFingerprint(bindingCwd) };
    })() } : {}),
  };
}
