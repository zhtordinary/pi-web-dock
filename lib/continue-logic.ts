import type { AgentMessage, AssistantMessage, SessionMessage } from "@/lib/types";

/**
 * Pure decision logic for the continue-button / unattended auto-continue
 * feature. Kept side-effect free so it can be unit-tested in isolation.
 */

export const CONTINUE_TEXT = "继续";
export const MAX_AUTO_ATTEMPTS = 100;
export const BACKOFF_START_MS = 30_000;
export const BACKOFF_MAX_MS = 540_000;

export type ContinueErrorKind = "transient" | "overflow" | "fatal" | "none";

/** Known upstream/provider failure patterns used for classification and backoff. */
const TRANSIENT_RE =
  /500|502|503|504|temporarily unavailable|service unavailable|overloaded|overload|timed out|timeout|connection error|stream_read_error|upstream|busy|rate limit|429|disconnected|stream ended|EOF|internal_server_error|ECONNRESET|socket hang/i;

/** Common provider formats that carry an HTTP status in the error text. */
const HTTP_STATUS_RE =
  /(?:\bHTTP(?:\s+status)?\b|\bstatus(?:[_\s-]*code)?\b|\bcode\b|\b(?:API\s+)?error\b|\bresponse\b)\s*["':=(#-]*\s*(\d{3})\b/i;

/** Some gateways use 409 for a transient upstream failure, not a client conflict. */
const TRANSIENT_UPSTREAM_409_RE =
  /["']type["']\s*:\s*["']upstream_error["']|upstream[\s_-]+request[\s_-]+failed/i;

/** Return an HTTP status when the provider included one in its error details. */
export function extractHttpStatus(error: string): number | null {
  const match = HTTP_STATUS_RE.exec(error);
  if (!match) return null;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : null;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isKnownHttpStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

/** True when an error message looks like a transient upstream/provider failure. */
export function isTransientErrorMessage(error: string): boolean {
  const status = extractHttpStatus(error);
  if (status !== null && isTransientHttpStatus(status)) return true;
  if (status === 409 && TRANSIENT_UPSTREAM_409_RE.test(error)) return true;
  if (status !== null && isKnownHttpStatus(status)) return false;
  return TRANSIENT_RE.test(error);
}

const RETRY_AFTER_RE =
  /\bretry[_\s-]*after\b\s*["':=]*\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)?\b/i;

/** Parse a provider Retry-After hint when it is present in persisted error text. */
export function retryAfterMsFromError(error: string): number | null {
  const match = RETRY_AFTER_RE.exec(error);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit.startsWith("ms") ? 1 : unit.startsWith("m") ? 60_000 : 1_000;
  return Math.round(value * multiplier);
}

/** Context-window overflow — pi compacts these; plain retries never help. */
const OVERFLOW_RE =
  /context.{0,16}too.{0,16}large|exceeds the context|context window|context_window|context_length|maximum context|input length/i;

/** True when the assistant message contains real output (text or a tool call). */
export function hasRealOutput(msg: AssistantMessage): boolean {
  return msg.content.some(
    (block) =>
      (block.type === "text" && block.text.trim() !== "") || block.type === "toolCall",
  );
}

/** True when an assistant turn failed without an explicit user cancellation. */
function isFailedAssistant(msg: AssistantMessage): boolean {
  return msg.stopReason !== "aborted" &&
    (msg.stopReason === "error" || (msg.errorMessage ?? "").trim() !== "" || !hasRealOutput(msg));
}

function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * True when the latest continue has not been followed by effective assistant
 * output. Honcho custom messages and tool results are intentionally ignored.
 * This is the signal for retrying the existing continue turn instead of adding
 * another user message.
 */
export function hasPreviousContinueWithoutOutput(messages: SessionMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (userMessageText(message).trim() !== CONTINUE_TEXT) return false;
    return !messages.slice(i + 1).some(
      (entry) => entry.role === "assistant" && !isFailedAssistant(entry as AssistantMessage),
    );
  }
  return false;
}

export type ContinueRetryMode = "continue" | "remove-assistant" | "none";

/** Last live-agent message that can participate in a continue retry.
 * System loadouts and custom display messages do not define a user turn.
 * Repeated retries chain empty failed assistants (each retry appends another
 * error turn); the whole chain is stripped so continue resumes from the last
 * real user/toolResult (or completed assistant) message below it. An aborted
 * assistant stops the walk: the user canceled, never auto-retry.
 */
export function continueRetryIndex(messages: SessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const msg = messages[index];
    if (msg?.role === "custom" || msg?.role === "system") continue;
    if (msg?.role === "assistant") {
      const failed = isFailedAssistant(msg as AssistantMessage);
      if (failed) continue;
    }
    return index;
  }
  return -1;
}

export interface SchedulerState {
  active: boolean;
  reason: "error" | "limit" | "fatal" | "idle" | "canceled" | "manual" | "restart";
  attempt: number;
  nextDelayMs: number | null;
  errorMessage: string | null;
  /** Absolute client/server time for this retry. */
  nextRetryAt?: number | null;
  /** Stable error key of the tail this scheduler is waiting on. */
  key?: string | null;
}

function isManualUserTail(messages: AgentMessage[], currentKey?: string | null): boolean {
  return lastUserMessageIsManual(messages, CONTINUE_TEXT, currentKey);
}

function schedulerKey(messages: AgentMessage[]): string | null {
  const last = lastAssistantClassification(messages);
  if (!last) return null;
  // Error timestamps change on every retry. Key scheduler to user turn so
  // backoff attempt survives a new transient error in same turn.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return `user:${message.timestamp ?? index}:${userMessageText(message)}`;
  }
  return `assistant:${last.msg.timestamp ?? 0}`;
}

/**
 * True when a scheduler should continue the failed turn: the last continue
 * (or the whole tail) has no effective assistant output, and the tail is not
 * a manual user message.
 */
export function shouldAutoRetry(messages: AgentMessage[], currentKey?: string | null): boolean {
  if (isManualUserTail(messages, currentKey)) return false;
  const last = lastAssistantClassification(messages);
  if (!last || (last.kind !== "transient" && last.kind !== "fatal")) return false;
  return hasPreviousContinueWithoutOutput(messages) || isFailedAssistant(last.msg);
}

/**
 * True when an already-scheduled retry should be canceled: a new manual user
 * message arrived, or a real assistant output was produced.
 */
export function shouldCancelAutoRetry(messages: AgentMessage[], currentKey?: string | null): boolean {
  if (isManualUserTail(messages, currentKey)) return true;
  const last = lastAssistantClassification(messages);
  if (!last) return false;
  const retryable = last.kind === "transient" || last.kind === "fatal";
  return !retryable || (!hasPreviousContinueWithoutOutput(messages) && !isFailedAssistant(last.msg));
}

/**
 * Decide the next unattended scheduler state given the latest messages.
 * Returns null when no state change is required (idempotent snapshot).
 */
export function nextSchedulerState(messages: AgentMessage[], current: SchedulerState | null): SchedulerState | null {
  if (!messages.length) return null;
  if (isManualUserTail(messages, current?.key)) {
    return current?.active
      ? { active: false, reason: "manual", attempt: 0, nextDelayMs: null, errorMessage: current.errorMessage, nextRetryAt: null, key: current.key }
      : null;
  }
  const key = schedulerKey(messages);
  if (!key) return null;
  const last = lastAssistantClassification(messages);
  if (!last) return null;
  if (last.kind === "none") {
    const reason = last.msg.stopReason === "aborted" ? "manual" : "idle";
    return current?.active ? { active: false, reason, attempt: 0, nextDelayMs: null, errorMessage: null, nextRetryAt: null, key: null } : null;
  }
  if (last.kind === "overflow") {
    return current?.active ? { active: false, reason: "fatal", attempt: 0, nextDelayMs: null, errorMessage: last.msg.errorMessage ?? null, nextRetryAt: null, key: null } : null;
  }
  // Same error already scheduled: keep the existing timer and attempt count.
  if (current?.active && current.key === key) return null;
  const attempt = current?.key === key ? current.attempt : 0;
  if (attempt >= MAX_AUTO_ATTEMPTS) {
    return { active: false, reason: "limit", attempt, nextDelayMs: null, errorMessage: last.msg.errorMessage ?? null, nextRetryAt: null, key: null };
  }
  const delay = nextBackoffDelayMs(attempt, key, last.msg.errorMessage);
  return {
    active: true,
    reason: "error",
    attempt: attempt + 1,
    nextDelayMs: delay,
    errorMessage: last.msg.errorMessage ?? null,
    nextRetryAt: Date.now() + delay,
    key,
  };
}

/**
 * Select how RPC should resume the latest continue turn from live agent state.
 * A user/toolResult anchors the retry; native system loadouts stay in context.
 * A terminal assistant with no effective output must be removed first. A bare failed assistant tail
 * (no user:继续 yet) is retryable the same way — Agent.continue() resumes the
 * last user/toolResult turn without appending a new message.
 */
export function continueRetryMode(messages: SessionMessage[]): ContinueRetryMode {
  const index = continueRetryIndex(messages);
  const last = index >= 0 ? messages[index] : undefined;
  if (!last) return "none";
  if (last.role === "assistant") {
    if (last.stopReason === "aborted") return "none";
    return isFailedAssistant(last as AssistantMessage) ? "remove-assistant" : "none";
  }
  if (last.role === "user" || last.role === "toolResult") {
    // A failed assistant chain above the anchor means the resumed turn never
    // produced output: retry it in place (same turn, no new user message).
    const hasFailedTail = messages.slice(index + 1).some(
      (entry) => entry.role === "assistant" && isFailedAssistant(entry as AssistantMessage),
    );
    if (hasFailedTail) return "continue";
    // Metadata after a pending user/toolResult does not complete its turn.
    if (messages.slice(index + 1).every((message) => message.role === "system" || message.role === "custom")) return "continue";
    return hasPreviousContinueWithoutOutput(messages) ? "continue" : "none";
  }
  return "none";
}

/**
 * Classify the last assistant message for continue purposes:
 * - "none"      — no error, real output happened, or user aborted (never auto).
 * - "transient" — known upstream glitch; safe to auto-continue with backoff.
 * - "overflow"  — context overflow; compact first, never blind-retry.
 * - "fatal"     — other failed assistant output; manual Continue still recovers it.
 */
export function classifyAssistantMessage(
  msg: AssistantMessage | undefined | null,
): ContinueErrorKind {
  if (!msg || msg.role !== "assistant") return "none";
  if (msg.stopReason === "aborted") return "none";
  const err = msg.errorMessage ?? "";
  if (msg.stopReason === "length" || OVERFLOW_RE.test(err)) return "overflow";
  if (msg.stopReason === "error" || err !== "") {
    // Error metadata wins over content: partial tool calls/text are not a
    // completed turn and must use the same retry path as manual Continue.
    return isTransientErrorMessage(err) ? "transient" : "fatal";
  }
  return "none";
}

export interface LastAssistant {
  kind: ContinueErrorKind;
  msg: AssistantMessage;
}

/** Last assistant message in the session, classified. Null when none exists. */
export function lastAssistantClassification(
  messages: AgentMessage[],
): LastAssistant | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    return { kind: classifyAssistantMessage(m as AssistantMessage), msg: m as AssistantMessage };
  }
  return null;
}

/**
 * True when the tail of the conversation is a user message that is NOT the
 * continue message itself — i.e. the human typed something new, which must
 * cancel the current auto-continue flow without changing the session preference.
 */
export function lastUserMessageIsManual(
  messages: AgentMessage[],
  continueText: string = CONTINUE_TEXT,
  currentKey?: string | null,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") return false;
    if (m.role !== "user") continue;
    if (userMessageText(m).trim() === continueText) return false;
    const msgKey = `user:${m.timestamp ?? i}:${userMessageText(m)}`;
    if (currentKey && currentKey === msgKey) return false;
    return true;
  }
  return false;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Backoff delay with stable jitter and an optional provider Retry-After hint. */
export function nextBackoffDelayMs(
  attempt: number,
  seed?: string | null,
  errorMessage?: string | null,
): number {
  const base = attempt <= 0
    ? BACKOFF_START_MS
    : Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS);
  const retryAfter = retryAfterMsFromError(errorMessage ?? "");
  if (retryAfter !== null) return Math.max(base, retryAfter);
  if (!seed) return base;

  // Keep jitter deterministic so server deadline and client countdown agree.
  const range = Math.max(1_000, Math.round(base * 0.1));
  const offset = (stableHash(`${seed}:${attempt}`) % (range * 2 + 1)) - range;
  return Math.min(BACKOFF_MAX_MS, Math.max(1_000, base + offset));
}

/** Stable identity for one assistant error, used to avoid reprocessing. */
export function errorKey(msg: AssistantMessage): string {
  return `${msg.timestamp ?? 0}:${msg.stopReason ?? ""}:${(msg.errorMessage ?? "").slice(0, 120)}`;
}
