import { existsSync } from "node:fs";
import { getRpcSession } from "./rpc-manager";
import {
  buildSessionContext,
  resolveSessionPathReadOnly,
} from "./session-reader";
import { getSessionReadSnapshot } from "./session-read-cache";
import { computeSessionRevision } from "./session-revision";
import { redactLiveValue } from "./live-agent-events";
import { resolveSafeHistorySource } from "./reader-safe-history-source";
import type { SessionEntry } from "./types";

const MAX_ENTRIES = 100;
const DEFAULT_ENTRIES = 20;
const MAX_BYTES = 128 * 1024;

function boundedInteger(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value === null || value === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} is outside the supported bound`);
  return parsed;
}

function textOf(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (object.type === "image" || object.type === "image_url") return "[image omitted]";
  if (object.type === "toolCall") return "";
  return ["text", "thinking", "content", "message", "output", "summary"]
    .map((key) => textOf(object[key], depth + 1))
    .filter(Boolean)
    .join("\n");
}

function projectMessage(message: unknown, entryId: string | undefined): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const raw = message as Record<string, unknown>;
  const role = typeof raw.role === "string" ? raw.role : "";
  if (!["user", "assistant", "toolResult", "bashExecution"].includes(role)) return null;
  const content = raw.content ?? raw.text ?? raw.message ?? raw.output;
  const text = textOf(content).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const projected = redactLiveValue({
    role,
    ...(entryId ? { entryId } : {}),
    text: text.length > 16_000 ? `${text.slice(0, 15_999)}…` : text,
    ...(typeof raw.timestamp === "string" ? { timestamp: raw.timestamp } : {}),
    ...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}),
  });
  return projected && typeof projected === "object" && !Array.isArray(projected)
    ? projected as Record<string, unknown>
    : null;
}

function fitMessageToByteBudget(
  projected: Record<string, unknown>,
  maxBytes: number,
): { value: Record<string, unknown>; truncated: boolean } | null {
  const serializedBytes = (value: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedBytes(projected) <= maxBytes) return { value: projected, truncated: false };

  const role = typeof projected.role === "string" ? projected.role : "message";
  const entryId = typeof projected.entryId === "string" ? projected.entryId : undefined;
  const text = typeof projected.text === "string" ? projected.text : "";
  const base: Record<string, unknown> = {
    role,
    ...(entryId ? { entryId } : {}),
    text: "",
  };
  if (serializedBytes(base) > maxBytes) {
    const minimal = { role: "message", text: "" };
    return serializedBytes(minimal) <= maxBytes ? { value: minimal, truncated: true } : null;
  }

  let low = 0;
  let high = text.length;
  let best = base;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidateText = length < text.length ? `${text.slice(0, Math.max(0, length - 1))}…` : text;
    const candidate = { ...base, text: candidateText };
    if (serializedBytes(candidate) <= maxBytes) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return { value: best, truncated: true };
}

export async function readSafeSessionHistory(input: {
  sessionId: string;
  tail?: number;
  maxEntries?: number;
  maxBytes?: number;
}): Promise<Record<string, unknown>> {
  const live = getRpcSession(input.sessionId);
  const liveRpc = live?.isAlive() ? live : undefined;
  // AgentSessionWrapper.sessionFile mirrors the SDK field, which can be empty
  // while the live session manager already knows the durable JSONL path. Use
  // that manager-owned path before falling back to the read-only catalog
  // resolver so live safe-history responses can guide callers to older rows.
  const liveSessionManager = liveRpc?.inner?.sessionManager;
  const liveSessionFile = liveRpc?.sessionFile || "";
  const managerSessionFile = liveSessionManager?.getSessionFile?.() || "";
  const persistedSessionFile = liveSessionFile || managerSessionFile
    ? ""
    : await resolveSessionPathReadOnly(input.sessionId) || "";
  const source = resolveSafeHistorySource({
    runtimeAlive: Boolean(liveRpc),
    liveSessionFile,
    managerSessionFile,
    persistedSessionFile,
  });
  if (!source) throw new Error("Session not found");
  const filePath = source.sessionFilePath || "";

  // A live runtime owns the freshest in-memory branch. Only the stopped path
  // opens the persisted JSONL snapshot; otherwise a streaming assistant/tool
  // update would be silently replaced by the last durable file version.
  const snapshot = !liveRpc && filePath && existsSync(filePath) ? getSessionReadSnapshot(filePath) : null;
  // SAFETY: Both the live session manager and the persisted snapshot yield raw session entries conforming to SessionEntry.
  const entries = (liveRpc?.inner.sessionManager.getEntries() ?? snapshot?.entries ?? []) as unknown as SessionEntry[];
  const leafId = liveRpc?.inner.sessionManager.getLeafId?.() ?? snapshot?.leafId ?? null;
  const tail = Math.min(MAX_ENTRIES, Math.max(1, input.tail ?? DEFAULT_ENTRIES));
  const maxEntries = Math.min(MAX_ENTRIES, Math.max(1, input.maxEntries ?? tail));
  const maxBytes = Math.min(MAX_BYTES, Math.max(4096, input.maxBytes ?? MAX_BYTES));
  const context = buildSessionContext(entries, leafId, {
    tail,
    deferThinking: true,
    deferToolResultImages: true,
    deferToolResultText: true,
    sessionId: input.sessionId,
  });
  const messages: Record<string, unknown>[] = [];
  let bytesRead = 0;
  let truncated = false;
  for (let index = Math.max(0, context.messages.length - maxEntries); index < context.messages.length; index += 1) {
    const projected = projectMessage(context.messages[index], context.entryIds[index]);
    if (!projected) continue;
    const fitted = fitMessageToByteBudget(projected, maxBytes);
    if (!fitted) {
      truncated = true;
      break;
    }
    const bytes = Buffer.byteLength(JSON.stringify(fitted.value), "utf8");
    if (messages.length > 0 && bytesRead + bytes > maxBytes) {
      truncated = true;
      break;
    }
    messages.push(fitted.value);
    bytesRead += bytes;
    truncated ||= fitted.truncated;
  }
  const latestEntryId = entries.at(-1)?.id ?? null;
  return {
    source: "reader-safe-history",
    sessionId: input.sessionId,
    runtimeStatus: source.runtimeStatus,
    durableOnly: !liveRpc && Boolean(snapshot),
    runtimeStartAttempted: false,
    writeSideEffects: false,
    snapshotRevision: snapshot ? computeSessionRevision({
      filePath,
      sourceId: liveRpc ? `runtime:${input.sessionId}` : "disk",
      entryCount: entries.length,
      latestEntryId,
      leafId,
    }) : null,
    entries: messages,
    returnedCount: messages.length,
    bytesRead,
    sessionFilePath: source.sessionFilePath,
    truncated: truncated || messages.length < Math.min(maxEntries, context.messages.length),
    coverage: {
      source: source.coverageSource,
      complete: !liveRpc,
      ...(liveRpc ? { note: "Live memory may include output not yet present in JSONL; poll live events for the streaming boundary." } : {}),
    },
    nextAction: "poll_live_events_for_unpersisted_streaming_output",
  };
}

export { boundedInteger as boundedSafeHistoryInteger };
