import { createHash } from "node:crypto";

/**
 * Native marker written by the Reader host adapter through SessionManager.
 * The marker is the protocol record; this package never serializes a session
 * file and never keeps a second idempotency ledger.
 */
export const SESSION_CONTROL_CREATE_CUSTOM_TYPE = "pi-web:session-control-create";
export const SESSION_CONTROL_CREATE_VERSION = 4;
/** Native custom record for a session-control creation request. */
export const SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE = "pi-web:session-control-initial-message";
export const SESSION_CONTROL_INITIALIZATION_MESSAGE = "通过 session_control 新建会话；尚未提供初始任务";
const MAX_IDEMPOTENCY_KEY_CHARS = 160;
const MAX_INITIAL_MESSAGE_CHARS = 32_000;
const MAX_CALLER_SESSION_ID_CHARS = 256;
const MAX_CWD_CHARS = 4_096;

export type DurableCreateSource = "initialization" | "agent-message";
export type DurableCreateMessageKind = "generated-initialization" | "agent-initial-message";

export type DurableCreateStatus =
  | "created"
  | "reused"
  | "persisted-runtime-failed"
  | "recovery-failed"
  | "idempotency-conflict"
  | "failed";

export interface DurableSessionScope {
  /** The caller's native SessionManager id, not a process-local owner label. */
  callerSessionId: string;
  /** Canonical cwd selected by the Reader host adapter. */
  cwd: string;
}

export interface DurableSessionCreateRequest {
  idempotencyKey: string;
  scope: DurableSessionScope;
  /** Optional first user question; when supplied the host starts the first model turn after durable creation. */
  initialMessage?: string;
}

export interface DurableSessionCreateRecord {
  version: 3 | typeof SESSION_CONTROL_CREATE_VERSION;
  idempotencyKey: string;
  scope: DurableSessionScope;
  source: DurableCreateSource;
  messageKind: DurableCreateMessageKind;
  /** SHA-256 of the native custom creation record written by SessionManager. */
  messageDigest: string;
  /** Kept for the initialMessage API field; it equals messageDigest there. */
  initialMessageDigest?: string;
  sessionId: string;
}

export interface NativeSessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): readonly unknown[];
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
}

export interface DurableSessionFacts {
  sessionId: string;
  sessionDir?: string;
  sessionFile?: string;
  persisted: boolean;
  /** Native SessionManager.list() or a live transient runtime made it visible. */
  visibleInSessionList: boolean;
  /** Visibility from the native SDK list, including a runtime that has failed. */
  nativeListVisible: boolean;
  /** Visibility from the Reader live registry. */
  runtimeVisibleInReader: boolean;
  runtimeCreated: boolean;
  source: DurableCreateSource;
  messageKind: DurableCreateMessageKind;
  /** Digest of the actual native message read from the SDK entries. */
  messageDigest?: string;
  /** Whether the supplied initialMessage has been persisted as a real user turn. */
  initialUserMessageSent?: boolean;
}

export interface DurableSessionObservation extends DurableSessionFacts {
  initialMessageDigest?: string;
  /** Marker and the durable creation record were read back. */
  nativeRecordValid: boolean;
}

export interface DurableSessionResult extends DurableSessionFacts {
  success: boolean;
  status: DurableCreateStatus;
  idempotencyKey: string;
  scope: DurableSessionScope;
  initialMessageDigest?: string;
  reused: boolean;
  durability: "durable" | "none";
  error?: string;
}

/**
 * The host-owned filesystem lease is intentionally tiny. The protocol calls
 * assert() at boundaries where a compromised lease must stop further native
 * work; the host also checks it after the operation and before releasing the
 * lock.
 */
export interface DurableSessionAdmissionLease {
  assert(): void;
}

/** A lock/lease failure may carry facts already observed by the native host. */
export class DurableSessionAdmissionError extends Error {
  readonly result?: DurableSessionResult;

  constructor(message: string, result?: DurableSessionResult) {
    super(message);
    this.name = "DurableSessionAdmissionError";
    this.result = result;
  }
}

export interface DurableSessionHost {
  /**
   * Serialize findExisting plus create/recover across every process that
   * shares the native session directory. The Reader host owns the filesystem
   * lock because this protocol package does not know the real sessionDir.
   */
  withAdmissionLock(
    request: DurableSessionCreateRequest,
    operation: (lease: DurableSessionAdmissionLease) => Promise<DurableSessionResult>,
  ): Promise<DurableSessionResult>;
  findExisting(request: DurableSessionCreateRequest): Promise<DurableSessionObservation | undefined>;
  create(request: DurableSessionCreateRequest, lease: DurableSessionAdmissionLease): Promise<DurableSessionResult>;
  recover?(facts: DurableSessionObservation, request: DurableSessionCreateRequest, lease: DurableSessionAdmissionLease): Promise<DurableSessionResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceForMessage(initialMessage: string | undefined): DurableCreateSource {
  return initialMessage === undefined ? "initialization" : "agent-message";
}

export function messageKindForSource(source: DurableCreateSource): DurableCreateMessageKind {
  return source === "initialization" ? "generated-initialization" : "agent-initial-message";
}

function messageForRequest(initialMessage: string | undefined): string {
  return initialMessage === undefined ? SESSION_CONTROL_INITIALIZATION_MESSAGE : initialMessage;
}

function scopeIsValid(scope: unknown): scope is DurableSessionScope {
  if (!isRecord(scope)) return false;
  return typeof scope.callerSessionId === "string"
    && scope.callerSessionId.length > 0
    && scope.callerSessionId.length <= MAX_CALLER_SESSION_ID_CHARS
    && typeof scope.cwd === "string"
    && scope.cwd.length > 0
    && scope.cwd.length <= MAX_CWD_CHARS;
}

function normalizeScope(input: unknown): DurableSessionScope {
  if (!isRecord(input)) throw new Error("create_session requires scope.callerSessionId and scope.cwd");
  const callerSessionId = typeof input.callerSessionId === "string" ? input.callerSessionId.trim() : "";
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!callerSessionId || !cwd) throw new Error("create_session requires scope.callerSessionId and scope.cwd");
  if (callerSessionId.length > MAX_CALLER_SESSION_ID_CHARS) {
    throw new Error(`create_session callerSessionId exceeds ${MAX_CALLER_SESSION_ID_CHARS} characters`);
  }
  if (cwd.length > MAX_CWD_CHARS) throw new Error(`create_session scope.cwd exceeds ${MAX_CWD_CHARS} characters`);
  return { callerSessionId, cwd };
}

export function initialMessageDigest(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

/** Alias with a neutral name for host readback code. */
export const durableMessageDigest = initialMessageDigest;

export function normalizeDurableSessionCreate(input: Partial<DurableSessionCreateRequest>): DurableSessionCreateRequest {
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (!idempotencyKey) throw new Error("create_session requires idempotencyKey or a toolCallId-derived key");
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new Error(`create_session idempotencyKey exceeds ${MAX_IDEMPOTENCY_KEY_CHARS} characters`);
  }
  const scope = normalizeScope(input.scope);
  const initialMessage = input.initialMessage === undefined
    ? undefined
    : typeof input.initialMessage === "string"
      ? input.initialMessage
      : undefined;
  if (initialMessage !== undefined && initialMessage.length > MAX_INITIAL_MESSAGE_CHARS) {
    throw new Error(`create_session initialMessage exceeds ${MAX_INITIAL_MESSAGE_CHARS} characters`);
  }
  return { idempotencyKey, scope, ...(initialMessage === undefined ? {} : { initialMessage }) };
}

export function durableScopeKey(request: Pick<DurableSessionCreateRequest, "scope" | "idempotencyKey">): string {
  return JSON.stringify([request.scope.callerSessionId, request.scope.cwd, request.idempotencyKey]);
}

/** Stable filesystem-safe key for the host-owned cross-process admission lock. */
export function durableAdmissionLockKey(request: Pick<DurableSessionCreateRequest, "scope" | "idempotencyKey">): string {
  return createHash("sha256").update(durableScopeKey(request), "utf8").digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function markerSource(data: Record<string, unknown>): DurableCreateSource | undefined {
  return data.source === "initialization" || data.source === "agent-message" ? data.source : undefined;
}

function recordFromData(data: Record<string, unknown>): DurableSessionCreateRecord | undefined {
  const legacy = data.version === 3;
  if (!legacy && data.version !== SESSION_CONTROL_CREATE_VERSION) return undefined;
  if (typeof data.idempotencyKey !== "string" || !scopeIsValid(data.scope)) return undefined;
  const source = legacy
    ? data.source === "initialization" ? "initialization" : data.source === "user-message" ? "agent-message" : undefined
    : markerSource(data);
  const messageKind = data.messageKind;
  if (!source) return undefined;
  const expectedMessageKind = messageKindForSource(source);
  if (legacy
    ? messageKind !== (source === "initialization" ? "generated-initialization" : "user-initial-message")
    : messageKind !== expectedMessageKind) return undefined;
  if (typeof data.sessionId !== "string" || !data.sessionId || !isSha256(data.messageDigest)) return undefined;
  if (source === "agent-message") {
    if (!isSha256(data.initialMessageDigest) || data.initialMessageDigest !== data.messageDigest) return undefined;
  } else if (data.initialMessageDigest !== undefined) {
    return undefined;
  }
  return {
    version: legacy ? 3 : SESSION_CONTROL_CREATE_VERSION,
    idempotencyKey: data.idempotencyKey,
    scope: { callerSessionId: data.scope.callerSessionId, cwd: data.scope.cwd },
    source,
    messageKind: expectedMessageKind,
    messageDigest: data.messageDigest,
    ...(typeof data.initialMessageDigest === "string" ? { initialMessageDigest: data.initialMessageDigest } : {}),
    sessionId: data.sessionId,
  };
}

export function findDurableSessionCreateRecord(
  entries: readonly unknown[],
  scope: DurableSessionScope,
  idempotencyKey: string,
): DurableSessionCreateRecord | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_CONTROL_CREATE_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data)) continue;
    const record = recordFromData(entry.data);
    if (!record || record.idempotencyKey !== idempotencyKey) continue;
    if (record.scope.callerSessionId !== scope.callerSessionId || record.scope.cwd !== scope.cwd) continue;
    return record;
  }
  return undefined;
}

/**
 * Keep pre-native-custom create identities visible to the host so a retry
 * cannot silently create a second session under the same scoped key. They are
 * intentionally mapped to the new fingerprint but never validate as durable
 * records because their first message was a role=user entry.
 */
export function findLegacyDurableSessionCreateRecord(
  entries: readonly unknown[],
  scope: DurableSessionScope,
  idempotencyKey: string,
): DurableSessionCreateRecord | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_CONTROL_CREATE_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data) || entry.data.version !== 3) continue;
    if (typeof entry.data.idempotencyKey !== "string" || entry.data.idempotencyKey !== idempotencyKey || !scopeIsValid(entry.data.scope)) continue;
    if (entry.data.scope.callerSessionId !== scope.callerSessionId || entry.data.scope.cwd !== scope.cwd) continue;
    const legacySource = entry.data.source;
    const source = legacySource === "initialization" ? "initialization" : legacySource === "user-message" ? "agent-message" : undefined;
    if (!source || entry.data.messageKind !== (source === "initialization" ? "generated-initialization" : "user-initial-message")) continue;
    if (typeof entry.data.sessionId !== "string" || !entry.data.sessionId || !isSha256(entry.data.messageDigest)) continue;
    if (source === "agent-message" && (!isSha256(entry.data.initialMessageDigest) || entry.data.initialMessageDigest !== entry.data.messageDigest)) continue;
    return {
      version: 3,
      idempotencyKey,
      scope: { callerSessionId: scope.callerSessionId, cwd: scope.cwd },
      source,
      messageKind: messageKindForSource(source),
      messageDigest: entry.data.messageDigest,
      ...(source === "agent-message" ? { initialMessageDigest: entry.data.messageDigest } : {}),
      sessionId: entry.data.sessionId,
    };
  }
  return undefined;
}

function hasLegacyInitialMessage(entries: readonly unknown[], record: DurableSessionCreateRecord): boolean {
  const expected = record.source === "initialization" ? SESSION_CONTROL_INITIALIZATION_MESSAGE : undefined;
  return entries.some((entry) => {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return false;
    const content = entry.message.content;
    return typeof content === "string"
      && (expected === undefined ? initialMessageDigest(content) === record.messageDigest : content === expected)
      && initialMessageDigest(content) === record.messageDigest;
  });
}

function hasExpectedMessage(entries: readonly unknown[], record: DurableSessionCreateRecord): boolean {
  return entries.some((entry) => {
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE) return false;
    if (typeof entry.content !== "string" || entry.display !== true) return false;
    if (!isRecord(entry.details)
      || entry.details.source !== "session-control-create"
      || entry.details.sessionId !== record.sessionId
      || entry.details.idempotencyKey !== record.idempotencyKey
      || entry.details.messageKind !== record.messageKind
      || entry.details.messageDigest !== record.messageDigest) return false;
    if (record.messageKind === "generated-initialization" && entry.content !== SESSION_CONTROL_INITIALIZATION_MESSAGE) return false;
    return initialMessageDigest(entry.content) === record.messageDigest;
  });
}

function expectedRecordFingerprint(request: DurableSessionCreateRequest): {
  source: DurableCreateSource;
  messageKind: DurableCreateMessageKind;
  messageDigest: string;
  initialMessageDigest?: string;
} {
  const source = sourceForMessage(request.initialMessage);
  const messageKind = messageKindForSource(source);
  const messageDigest = initialMessageDigest(messageForRequest(request.initialMessage));
  return {
    source,
    messageKind,
    messageDigest,
    ...(source === "agent-message" ? { initialMessageDigest: messageDigest } : {}),
  };
}

/** Validate the native marker and the durable creation record after reopening. */
export function validateDurableSessionCreateRecord(
  entries: readonly unknown[],
  request: DurableSessionCreateRequest,
): DurableSessionCreateRecord | undefined {
  const normalized = normalizeDurableSessionCreate(request);
  const record = findDurableSessionCreateRecord(entries, normalized.scope, normalized.idempotencyKey);
  if (!record) return undefined;
  const expected = expectedRecordFingerprint(normalized);
  if (
    record.source !== expected.source
    || record.messageKind !== expected.messageKind
    || record.messageDigest !== expected.messageDigest
    || record.initialMessageDigest !== expected.initialMessageDigest
    || !validateDurableSessionRecord(entries, record)
  ) return undefined;
  return record;
}

/** Validate a marker using its recorded fingerprint, for idempotency recovery. */
export function validateDurableSessionRecord(
  entries: readonly unknown[],
  record: DurableSessionCreateRecord,
): boolean {
  const found = findDurableSessionCreateRecord(entries, record.scope, record.idempotencyKey);
  if (!found) return false;
  if (found.version === 3) {
    return found.version === record.version
      && found.source === record.source
      && found.messageKind === record.messageKind
      && found.sessionId === record.sessionId
      && found.initialMessageDigest === record.initialMessageDigest
      && found.messageDigest === record.messageDigest
      && hasLegacyInitialMessage(entries, found);
  }
  return found.sessionId === record.sessionId
    && found.source === record.source
    && found.messageKind === record.messageKind
    && found.messageDigest === record.messageDigest
    && found.initialMessageDigest === record.initialMessageDigest
    && hasExpectedMessage(entries, found);
}

/** Explicitly created sessions are not anonymous composer drafts. */
export function hasDurableSessionCreation(entries: readonly unknown[], nativeSessionId: string): boolean {
  return entries.some((entry) => {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_CONTROL_CREATE_CUSTOM_TYPE || !isRecord(entry.data)) return false;
    const record = recordFromData(entry.data);
    return record?.sessionId === nativeSessionId && validateDurableSessionRecord(entries, record);
  });
}

/**
 * Append the native marker and durable creation record. The host supplies a
 * manager whose header has already crossed the public SDK persistence boundary;
 * the host dispatches any supplied initial user prompt separately. This helper
 * never serializes JSONL and never calls a private SDK persistence method.
 */
export function appendDurableSessionCreate(
  manager: NativeSessionManagerLike,
  request: DurableSessionCreateRequest,
): { record: DurableSessionCreateRecord; customEntryId: string; messageEntryId: string } {
  const normalized = normalizeDurableSessionCreate(request);
  const expected = expectedRecordFingerprint(normalized);
  const entries = manager.getEntries();
  const existing = findDurableSessionCreateRecord(entries, normalized.scope, normalized.idempotencyKey);
  if (existing) {
    if (
      existing.source !== expected.source
      || existing.messageKind !== expected.messageKind
      || existing.messageDigest !== expected.messageDigest
      || existing.initialMessageDigest !== expected.initialMessageDigest
    ) throw new Error("create_session idempotencyKey was already used with a different scope or initialMessage");
    if (existing.version === 3) {
      if (!validateDurableSessionRecord(entries, existing)) throw new Error("legacy create_session record is inconsistent");
      const marker = entries.find((entry) => isRecord(entry) && entry.type === "custom"
        && entry.customType === SESSION_CONTROL_CREATE_CUSTOM_TYPE && isRecord(entry.data)
        && entry.data.idempotencyKey === existing.idempotencyKey && entry.data.sessionId === existing.sessionId
        && isRecord(entry.data.scope) && entry.data.scope.callerSessionId === existing.scope.callerSessionId
        && entry.data.scope.cwd === existing.scope.cwd) as Record<string, unknown> | undefined;
      const initial = entries.find((entry) => isRecord(entry) && entry.type === "message"
        && isRecord(entry.message) && entry.message.role === "user" && typeof entry.message.content === "string"
        && initialMessageDigest(entry.message.content) === existing.messageDigest) as Record<string, unknown> | undefined;
      if (typeof marker?.id !== "string" || typeof initial?.id !== "string") throw new Error("legacy create_session entry identity is missing");
      return { record: existing, customEntryId: marker.id, messageEntryId: initial.id };
    }
    if (hasExpectedMessage(entries, existing)) throw new Error("create_session idempotencyKey is already present");

    // The marker is appended before the native custom message so a failure at
    // the second SDK append cannot create a second session on retry. Complete
    // that exact marker only when no custom message for this key was written;
    // a present-but-invalid message is corruption, not a safe retry.
    const markerEntry = entries.find((entry) => {
      if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SESSION_CONTROL_CREATE_CUSTOM_TYPE || !isRecord(entry.data)) return false;
      const candidate = recordFromData(entry.data);
      return candidate?.idempotencyKey === existing.idempotencyKey
        && candidate.scope.callerSessionId === existing.scope.callerSessionId
        && candidate.scope.cwd === existing.scope.cwd
        && candidate.sessionId === existing.sessionId;
    });
    const marker = markerEntry as Record<string, unknown> | undefined;
    if (!marker || typeof marker.id !== "string") throw new Error("create_session marker entry is not readable");
    const hasAnyMessage = entries.some((entry) => {
      if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE || !isRecord(entry.details)) return false;
      return entry.details.idempotencyKey === existing.idempotencyKey && entry.details.sessionId === existing.sessionId;
    });
    if (hasAnyMessage) throw new Error("create_session native custom message is present but failed validation");
    const messageEntryId = manager.appendCustomMessageEntry(
      SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE,
      messageForRequest(normalized.initialMessage),
      true,
      {
        source: "session-control-create",
        sessionId: existing.sessionId,
        idempotencyKey: existing.idempotencyKey,
        messageKind: existing.messageKind,
        messageDigest: existing.messageDigest,
      },
    );
    return { record: existing, customEntryId: marker.id, messageEntryId };
  }

  const record: DurableSessionCreateRecord = {
    version: SESSION_CONTROL_CREATE_VERSION,
    idempotencyKey: normalized.idempotencyKey,
    scope: normalized.scope,
    source: expected.source,
    messageKind: expected.messageKind,
    messageDigest: expected.messageDigest,
    ...(expected.initialMessageDigest ? { initialMessageDigest: expected.initialMessageDigest } : {}),
    sessionId: manager.getSessionId(),
  };
  const customEntryId = manager.appendCustomEntry(SESSION_CONTROL_CREATE_CUSTOM_TYPE, record);
  const messageEntryId = manager.appendCustomMessageEntry(
    SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE,
    messageForRequest(normalized.initialMessage),
    true,
    {
      source: "session-control-create",
      sessionId: record.sessionId,
      idempotencyKey: record.idempotencyKey,
      messageKind: record.messageKind,
      messageDigest: record.messageDigest,
    },
  );
  return { record, customEntryId, messageEntryId };
}

const idempotencyLocks = new Map<string, Promise<void>>();

async function withIdempotencyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = idempotencyLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  idempotencyLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (idempotencyLocks.get(key) === current) idempotencyLocks.delete(key);
  }
}

function emptyFacts(source: DurableCreateSource): DurableSessionFacts {
  return {
    sessionId: "",
    persisted: false,
    visibleInSessionList: false,
    nativeListVisible: false,
    runtimeVisibleInReader: false,
    runtimeCreated: false,
    source,
    messageKind: messageKindForSource(source),
  };
}

function factsVisible(facts: DurableSessionFacts): boolean {
  return facts.visibleInSessionList || facts.nativeListVisible || facts.runtimeVisibleInReader;
}

export function createDurableSessionResult(
  request: DurableSessionCreateRequest,
  facts: DurableSessionFacts,
  status: DurableCreateStatus,
  reused: boolean,
  error?: string,
): DurableSessionResult {
  const visible = factsVisible(facts);
  const normalizedFacts = { ...facts, visibleInSessionList: visible };
  const durable = facts.persisted && facts.nativeListVisible && (status === "created" || status === "reused");
  return {
    ...normalizedFacts,
    success: durable,
    status,
    idempotencyKey: request.idempotencyKey,
    scope: request.scope,
    ...(request.initialMessage === undefined ? {} : { initialMessageDigest: initialMessageDigest(request.initialMessage) }),
    reused,
    durability: durable ? "durable" : "none",
    ...(error ? { error } : {}),
  };
}

function existingFingerprintMatches(
  existing: DurableSessionObservation,
  request: DurableSessionCreateRequest,
): boolean {
  const expected = expectedRecordFingerprint(request);
  return existing.source === expected.source
    && existing.messageKind === expected.messageKind
    && existing.messageDigest === expected.messageDigest
    && existing.initialMessageDigest === expected.initialMessageDigest;
}

function fallbackScope(input: Partial<DurableSessionCreateRequest>): DurableSessionScope {
  const scope = input.scope;
  return scopeIsValid(scope)
    ? { callerSessionId: scope.callerSessionId, cwd: scope.cwd }
    : { callerSessionId: "", cwd: "" };
}

function admissionFailureResult(
  request: DurableSessionCreateRequest,
  error: unknown,
  observed?: DurableSessionResult,
): DurableSessionResult {
  const message = errorText(error);
  if (!observed) {
    return {
      ...emptyFacts(sourceForMessage(request.initialMessage)),
      success: false,
      status: "failed",
      idempotencyKey: request.idempotencyKey,
      scope: request.scope,
      ...(request.initialMessage === undefined ? {} : { initialMessageDigest: initialMessageDigest(request.initialMessage) }),
      reused: false,
      durability: "none",
      error: message,
    };
  }

  // A lease can be lost after the native SDK has flushed a transcript. Keep
  // those facts, but never expose the operation as a successful durable create.
  const status = observed.status === "created" || observed.status === "reused"
    ? "persisted-runtime-failed"
    : observed.status;
  return {
    ...observed,
    success: false,
    status,
    durability: "none",
    error: observed.error ? `${observed.error}; ${message}` : message,
  };
}

export async function createOrReuseDurableSession(
  input: Partial<DurableSessionCreateRequest>,
  host: DurableSessionHost,
): Promise<DurableSessionResult> {
  let request: DurableSessionCreateRequest;
  try {
    request = normalizeDurableSessionCreate(input);
  } catch (error) {
    const source = sourceForMessage(typeof input.initialMessage === "string" ? input.initialMessage : undefined);
    const fallbackRequest = {
      idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "",
      scope: fallbackScope(input),
      ...(typeof input.initialMessage === "string" ? { initialMessage: input.initialMessage } : {}),
    } as DurableSessionCreateRequest;
    return {
      ...emptyFacts(source),
      success: false,
      status: "failed",
      idempotencyKey: fallbackRequest.idempotencyKey,
      scope: fallbackRequest.scope,
      ...(fallbackRequest.initialMessage === undefined ? {} : { initialMessageDigest: initialMessageDigest(fallbackRequest.initialMessage) }),
      reused: false,
      durability: "none",
      error: errorText(error),
    };
  }

  try {
    return await host.withAdmissionLock(request, async (lease) => {
      lease.assert();
      return withIdempotencyLock(durableScopeKey(request), async () => {
        lease.assert();
        let existing: DurableSessionObservation | undefined;
        try {
          existing = await host.findExisting(request);
          lease.assert();
          if (existing) {
            if (!existingFingerprintMatches(existing, request)) {
              return createDurableSessionResult(request, existing, "idempotency-conflict", false, "create_session idempotencyKey was already used with a different scope or initialMessage");
            }
            if (!existing.nativeRecordValid) {
              if (host.recover) {
                lease.assert();
                const recovered = await host.recover(existing, request, lease);
                return { ...recovered, reused: true };
              }
              return createDurableSessionResult(request, existing, "recovery-failed", true, "native session marker or durable creation record digest failed readback validation");
            }
            const initialUserTurnMissing = request.initialMessage !== undefined && existing.initialUserMessageSent === false;
            if (!initialUserTurnMissing && existing.runtimeCreated && existing.runtimeVisibleInReader && existing.persisted && existing.nativeListVisible) {
              return createDurableSessionResult(request, existing, "reused", true);
            }
            if (host.recover) {
              lease.assert();
              const recovered = await host.recover(existing, request, lease);
              return { ...recovered, reused: true };
            }
            return createDurableSessionResult(request, existing, "recovery-failed", true, "native session is not currently visible in the Reader runtime");
          }
          lease.assert();
          const created = await host.create(request, lease);
          return { ...created, reused: false };
        } catch (error) {
          if (error instanceof DurableSessionAdmissionError) throw error;
          if (existing) {
            return createDurableSessionResult(request, existing, "recovery-failed", true, errorText(error));
          }
          return {
            ...emptyFacts(sourceForMessage(request.initialMessage)),
            success: false,
            status: "failed",
            idempotencyKey: request.idempotencyKey,
            scope: request.scope,
            ...(request.initialMessage === undefined ? {} : { initialMessageDigest: initialMessageDigest(request.initialMessage) }),
            reused: false,
            durability: "none",
            error: errorText(error),
          };
        }
      });
    });
  } catch (error) {
    return admissionFailureResult(
      request,
      error,
      error instanceof DurableSessionAdmissionError ? error.result : undefined,
    );
  }
}
