import { randomUUID } from "node:crypto";
import { toClientAgentEvent, type AgentEventLike } from "./agent-event-wire";

/** A process identity makes a cursor invalid after a Reader restart. */
const LIVE_EVENT_BOOT_ID_KEY = Symbol.for("pi-web.live-event-boot-id");
const liveEventGlobal = globalThis as Record<symbol, string | undefined>;
export const LIVE_EVENT_BOOT_ID = liveEventGlobal[LIVE_EVENT_BOOT_ID_KEY] ??= randomUUID();
export const LIVE_EVENT_BUFFER_SIZE = 256;
export const LIVE_EVENT_MAX_EVENT_BYTES = 32 * 1024;
export const LIVE_EVENT_MAX_EVENTS = 100;
export const LIVE_EVENT_MAX_BYTES = 128 * 1024;
/** Reserve space for the route's source/status/runtime-semantics envelope. */
export const LIVE_EVENT_ROUTE_ENVELOPE_BYTES = 3 * 1024;
export const LIVE_EVENT_SNAPSHOT_MIN_BYTES = 256;

export interface LiveAgentEventRecord {
  cursor: number;
  event: AgentEventLike;
}

export interface LiveAgentEventSlice {
  events: LiveAgentEventRecord[];
  nextCursor: number;
  oldestCursor: number;
  truncated: boolean;
  bytesRead: number;
}

const SECRET_KEY = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|credential|authorization|cookie|private[-_]?key)/i;
const MAX_STRING_BYTES = 8 * 1024;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ITEMS = 64;
const MAX_DEPTH = 7;

function redactText(value: string): string {
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]");
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, "$1 [REDACTED]");
  text = text.replace(/\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|credential|authorization|cookie)\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, "$1[REDACTED]");
  text = text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    const match = /^(https?:\/\/)([^/?#\s]+)(?:[/?#][^\s]*)?$/i.exec(url);
    if (!match) return "[REDACTED_URL]";
    const authority = match[2].replace(/^.*@/, "");
    return `${match[1]}${authority}/[REDACTED_PATH]`;
  });
  // Absolute local paths and URL paths can contain usernames, worktree names,
  // or copied credentials. Keep the host/origin shape only.
  text = text.replace(/(?:\/(?:Users|home|private|tmp|var|opt|Volumes|mnt)\/)[^\s"',)}\]]*/g, "[REDACTED_PATH]");
  text = text.replace(/\b[A-Za-z]:\\[^\s"',)}\]]*/g, "[REDACTED_PATH]");
  return text.length <= MAX_STRING_BYTES ? text : `${text.slice(0, MAX_STRING_BYTES - 1)}…`;
}

/**
 * Make an event safe to expose from the live inspection endpoint. This is a
 * projection, not a transcript export: depth, collection size, strings, and
 * secret-looking fields are all bounded before JSON serialization.
 */
export function redactLiveValue(value: unknown, depth = 0, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value);
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactLiveValue(item, depth + 1, key));
    if (value.length > MAX_ARRAY_ITEMS) output.push(`[${value.length - MAX_ARRAY_ITEMS} more items omitted]`);
    return output;
  }
  if (typeof value !== "object") return String(value);
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [childKey, childValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    if (SECRET_KEY.test(childKey)) {
      output[childKey] = "[REDACTED]";
      continue;
    }
    output[childKey] = redactLiveValue(childValue, depth + 1, childKey);
  }
  if (entries.length > MAX_OBJECT_KEYS) output._omittedKeys = entries.length - MAX_OBJECT_KEYS;
  return output;
}

/** Project a raw SDK event through the same client event wire used by SSE. */
export function publicLiveAgentEvent(event: AgentEventLike): AgentEventLike | null {
  try {
    const clientEvent = toClientAgentEvent(event);
    if (!clientEvent) return null;
    const bounded = redactLiveValue(clientEvent);
    if (!bounded || typeof bounded !== "object" || Array.isArray(bounded)) return null;
    const serialized = JSON.stringify(bounded);
    if (Buffer.byteLength(serialized, "utf8") <= LIVE_EVENT_MAX_EVENT_BYTES) return bounded as AgentEventLike;
    const originalType = (bounded as Record<string, unknown>).type;
    return {
      type: typeof originalType === "string" ? originalType : "event",
      truncated: true,
      note: "live event exceeded the per-event safety bound",
    };
  } catch {
    return {
      type: typeof event.type === "string" ? event.type : "event",
      truncated: true,
      note: "live event could not be safely projected",
    };
  }
}

export function appendLiveEvent(
  records: LiveAgentEventRecord[],
  cursor: number,
  event: AgentEventLike,
): number {
  const projected = publicLiveAgentEvent(event);
  if (!projected) return cursor;
  records.push({ cursor: cursor + 1, event: projected });
  while (records.length > LIVE_EVENT_BUFFER_SIZE) records.shift();
  return cursor + 1;
}

export function sliceLiveEvents(
  records: readonly LiveAgentEventRecord[],
  currentCursor: number,
  requestedCursor = 0,
  requestedLimit = 50,
  requestedMaxBytes = 64 * 1024,
): LiveAgentEventSlice {
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(LIVE_EVENT_MAX_EVENTS, Math.floor(requestedLimit)))
    : 50;
  const maxBytes = Number.isFinite(requestedMaxBytes)
    ? Math.max(LIVE_EVENT_SNAPSHOT_MIN_BYTES, Math.min(LIVE_EVENT_MAX_BYTES, Math.floor(requestedMaxBytes)))
    : 64 * 1024;
  const cursor = Number.isSafeInteger(requestedCursor)
    ? Math.max(0, Math.min(currentCursor, requestedCursor))
    : 0;
  const oldestCursor = records[0]?.cursor ?? currentCursor + 1;
  let truncated = cursor < oldestCursor - 1;
  const events: LiveAgentEventRecord[] = [];
  let bytesRead = 0;

  for (const record of records) {
    if (record.cursor <= cursor) continue;
    if (events.length >= limit) {
      truncated = true;
      break;
    }
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (events.length > 0 && bytesRead + bytes > maxBytes) {
      truncated = true;
      break;
    }
    if (events.length === 0 && bytes > maxBytes) {
      truncated = true;
      events.push({
        cursor: record.cursor,
        event: {
          type: "live_event_truncated",
          originalType: record.event.type,
          note: "live event exceeded the requested response bound",
        },
      });
      bytesRead = Buffer.byteLength(JSON.stringify(events[0]), "utf8");
      break;
    }
    events.push(record);
    bytesRead += bytes;
  }

  return {
    events,
    nextCursor: events.at(-1)?.cursor ?? cursor,
    oldestCursor,
    truncated,
    bytesRead,
  };
}
