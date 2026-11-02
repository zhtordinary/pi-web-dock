import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import type { Base64ImageAttachment } from "./image-attachments.js";
import type { SessionUsageMetadata } from "./types.js";

export const QUICK_ASK_USAGE_EVENT_VERSION = 1 as const;
export type QuickAskUsageEventRelation = "origin" | "copy" | "replace";

export interface QuickAskUsageEvent {
  version: typeof QUICK_ASK_USAGE_EVENT_VERSION;
  id: string;
  relation: QuickAskUsageEventRelation;
  sourceSessionId?: string;
  sourceEntryId?: string;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function validUsageEvent(value: unknown): value is QuickAskUsageEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.version === QUICK_ASK_USAGE_EVENT_VERSION
    && typeof event.id === "string"
    && event.id.trim().length > 0
    && (event.relation === "origin" || event.relation === "copy" || event.relation === "replace");
}

export function createQuickAskOriginUsageEvent(): QuickAskUsageEvent {
  return {
    version: QUICK_ASK_USAGE_EVENT_VERSION,
    id: `usage-${randomUUID()}`,
    relation: "origin",
  };
}

/** Create explicit provenance for a materialized Quick Ask with no provider call. */
export function createQuickAskDerivativeUsageEvent(
  sourceSessionId: string,
  sourceEntryId: string,
  source: QuickAskUsageEvent | undefined,
  relation: "copy" | "replace",
): QuickAskUsageEvent {
  const id = validUsageEvent(source)
    ? source.id
    : `legacy-${createHash("sha256").update(`${sourceSessionId}\u0000${sourceEntryId}`).digest("hex").slice(0, 32)}`;
  return {
    version: QUICK_ASK_USAGE_EVENT_VERSION,
    id,
    relation,
    sourceSessionId,
    sourceEntryId,
  };
}

/** Preserve every Reader-supported usage partition and synthesize a complete total. */
export function normalizeSessionUsage(value: unknown): SessionUsageMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const input = finiteNonNegative(usage.input) ?? 0;
  const output = finiteNonNegative(usage.output) ?? 0;
  const cacheRead = finiteNonNegative(usage.cacheRead) ?? 0;
  const cacheWrite = finiteNonNegative(usage.cacheWrite) ?? 0;
  const rawCacheWrite1h = finiteNonNegative(usage.cacheWrite1h);
  const cacheWrite1h = rawCacheWrite1h !== undefined ? Math.min(rawCacheWrite1h, cacheWrite) : undefined;
  const reasoning = finiteNonNegative(usage.reasoning);
  const totalTokens = finiteNonNegative(usage.totalTokens)
    ?? input + cacheRead + cacheWrite + output;
  const costValue = usage.cost;
  const normalizedCost = costValue && typeof costValue === "object" && !Array.isArray(costValue)
    ? Object.fromEntries(
        ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "total"]
          .flatMap((key) => {
            const value = (costValue as Record<string, unknown>)[key];
            const item = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
            return item === undefined ? [] : [[key, item]];
          }),
      )
    : undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(cacheWrite1h !== undefined && cacheWrite1h > 0 ? { cacheWrite1h } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    totalTokens,
    ...(normalizedCost && Object.keys(normalizedCost).length > 0 ? { cost: normalizedCost } : {}),
  };
}

export interface QuickAskData {
  question: string;
  answer: string;
  thinking?: string;
  images?: Base64ImageAttachment[];
  threadId?: string;
  threadTitle?: string;
  branchId?: string;
  model?: string;
  provider?: string;
  usage?: SessionUsageMetadata;
  cost?: number;
  createdAt: number;
  runId?: string;
  revision?: number;
  /** Fixed context origin, independent of the physical metadata parent. */
  contextAnchorId?: string | null;
  nativeEntries?: SessionEntry[];
  usageEvent?: QuickAskUsageEvent;
}

export interface QuickAskEntry {
  type: "custom";
  id: string;
  parentId?: string | null;
  timestamp: string;
  customType: "quick_ask";
  /** Display projection from the native assistant message; absent for flat historical records. */
  stopReason?: AssistantMessage["stopReason"];
  /** Model selection derived from native state, independent of actual usage attribution. */
  requestedModel?: { provider: string; modelId: string };
  provider?: string;
  model?: string;
  usage?: SessionUsageMetadata;
  usageEvent?: QuickAskUsageEvent;
  threadId?: string;
  threadTitle?: string;
  branchId?: string;
  data: QuickAskData;
}

export interface QuickAskDeleteEntry {
  type: "custom";
  id: string;
  timestamp: string;
  customType: "quick_ask_delete";
  targetId: string;
}

export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const fileStream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    yield line;
  }
}

function messageText(content: unknown, key = "text"): string {
  if (typeof content === "string") return key === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    const value = (block as Record<string, unknown>)[key];
    return typeof value === "string" ? [value] : [];
  }).join("");
}

/** Attachments are stored once, inside the admitted user message; every other view derives them from it. */
function userMessageImages(message: { content: unknown } | undefined): Base64ImageAttachment[] | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  return message.content.flatMap((block: { type?: string; data?: string; mimeType?: string }) =>
    block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
      ? [{ data: block.data, mimeType: block.mimeType }] : []);
}

export function nativeUserImages(nativeEntries: readonly SessionEntry[] | undefined): Base64ImageAttachment[] {
  const user = nativeEntries?.flatMap((native) => native.type === "message" ? [native.message] : []).find((message) => message.role === "user");
  return userMessageImages(user) ?? [];
}

/** The UI view is derived from the original SDK messages, not separately persisted text. */
export function normalizeQuickAskEntry(value: unknown, admitted: SessionEntry[] = []): QuickAskEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as QuickAskEntry;
  if (entry.type !== "custom" || entry.customType !== "quick_ask" || !entry.id || !entry.data) return undefined;
  const nativeEntries = [...admitted, ...(entry.data.nativeEntries ?? [])];
  const messages = nativeEntries.flatMap((native) => native.type === "message" ? [native.message] : []);
  const user = messages.find((message) => message.role === "user");
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  const question = user ? messageText(user.content) : entry.data.question;
  const answer = assistant ? messageText(assistant.content) : entry.data.answer;
  if (typeof question !== "string" || typeof answer !== "string") return undefined;
  const thinking = assistant ? messageText(assistant.content, "thinking") : entry.data.thinking;
  const images = userMessageImages(user) ?? entry.data.images;
  const modelState = nativeEntries.findLast((native) => native.type === "model_change"
    || (native.type === "message" && native.message.role === "assistant"));
  const requestedModel = modelState?.type === "model_change"
    ? { provider: modelState.provider, modelId: modelState.modelId }
    : modelState?.type === "message" && modelState.message.role === "assistant"
      ? { provider: modelState.message.provider, modelId: modelState.message.model } : undefined;
  const data: QuickAskData = { ...entry.data, question, answer, ...(thinking ? { thinking } : {}),
    ...(images?.length ? { images } : {}), ...(nativeEntries.length ? { nativeEntries } : {}) };
  return {
    ...entry, data, requestedModel,
    stopReason: assistant?.role === "assistant" ? assistant.stopReason : undefined,
    threadId: data.threadId ?? entry.threadId,
    threadTitle: data.threadTitle ?? entry.threadTitle,
    branchId: data.branchId ?? entry.branchId,
    provider: data.provider ?? entry.provider ?? (assistant?.role === "assistant" ? assistant.provider : undefined),
    model: data.model ?? entry.model ?? (assistant?.role === "assistant" ? assistant.model : undefined),
    usage: data.usage ?? entry.usage ?? (assistant?.role === "assistant" ? normalizeSessionUsage(assistant.usage) : undefined),
    usageEvent: data.usageEvent ?? entry.usageEvent,
  };
}

export function quickAskContextAnchor(entry: QuickAskEntry): string | null {
  return Object.hasOwn(entry.data, "contextAnchorId") ? entry.data.contextAnchorId ?? null : entry.parentId ?? null;
}

export function projectSessionQuickAsks(entries: Iterable<unknown>): QuickAskEntry[] {
  const itemsById = new Map<string, QuickAskEntry>();
  const deletedIds = new Set<string>();
  const admitted = new Map<string, SessionEntry[]>();

  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const obj = value as { type?: string; customType?: string; targetId?: string;
      data?: { id?: string; runId?: string; targetId?: string; threadId?: string; branchId?: string; nativeEntries?: SessionEntry[] } };
    if (obj.type === "custom" && obj.customType === "quick_ask_run" && obj.data?.id && obj.data.nativeEntries) {
      admitted.set(obj.data.id, obj.data.nativeEntries);
    }
    const item = normalizeQuickAskEntry(obj, obj.data?.runId ? admitted.get(obj.data.runId) : undefined);
    if (item) itemsById.set(item.id, item);
    else if (obj.type === "custom" && obj.customType === "quick_ask_delete") {
      const targetId = obj.data?.targetId ?? obj.targetId;
      if (targetId) { deletedIds.add(targetId); itemsById.delete(targetId); }
    } else if (obj.type === "custom" && obj.customType === "quick_ask_thread_delete") {
      for (const [id, entry] of itemsById) {
        if ((entry.data.threadId ?? entry.threadId ?? "default") === obj.data?.threadId
          && (entry.data.branchId ?? entry.branchId ?? "main") === (obj.data?.branchId ?? "main")) itemsById.delete(id);
      }
    }
  }

  for (const delId of deletedIds) {
    itemsById.delete(delId);
  }

  return Array.from(itemsById.values()).sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return ta - tb;
  });
}

/** Side Ask records of recently opened files; a hit costs one stat instead of a pass over a transcript of tens of MB. */
const RECORD_CACHE_MAX_FILES = 64;
const RECORD_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const recordCache = new Map<string, { version: string; bytes: number; records: SessionEntry[] }>();
const fileVersion = (info: Stats): string => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

function rememberRecords(filePath: string, version: string, bytes: number, records: SessionEntry[]): void {
  recordCache.delete(filePath);
  if (bytes > RECORD_CACHE_MAX_BYTES / 4) return;
  recordCache.set(filePath, { version, bytes, records });
  let total = 0;
  for (const entry of recordCache.values()) total += entry.bytes;
  for (const key of recordCache.keys()) {
    if (recordCache.size <= RECORD_CACHE_MAX_FILES && total <= RECORD_CACHE_MAX_BYTES) break;
    total -= recordCache.get(key)!.bytes;
    recordCache.delete(key);
  }
}

/** Session lines are compact JSON.stringify output, so every Side Ask record contains this exact key text. */
const QUICK_ASK_LINE_MARKER = '"customType":"quick_ask';

/**
 * The returned entries are shared read-only with the cache; callers project them and never edit them in place.
 * `lines` is the transcript reader, replaceable so a test can count how often the file is really read.
 */
export async function readQuickAskRecords(filePath: string, lines: (path: string) => AsyncIterable<string> = readJsonlLines): Promise<SessionEntry[]> {
  const version = fileVersion(await stat(filePath));
  const cached = recordCache.get(filePath);
  if (cached?.version === version) {
    recordCache.delete(filePath);
    recordCache.set(filePath, cached);
    return [...cached.records];
  }
  const entries: SessionEntry[] = [];
  let bytes = 0;
  for await (const line of lines(filePath)) {
    // Skip parsing the transcript; a marker match is still confirmed by the parsed entry below.
    if (!line.includes(QUICK_ASK_LINE_MARKER)) continue;
    try {
      const entry = JSON.parse(line) as SessionEntry;
      if (entry.type === "custom" && entry.customType.startsWith("quick_ask")) { entries.push(entry); bytes += line.length; }
    } catch { /* Preserve readable history around an incomplete line. */ }
  }
  // Only a scan that saw one stable file version may be reused.
  if (fileVersion(await stat(filePath)) === version) rememberRecords(filePath, version, bytes, entries);
  return [...entries];
}

export async function readSessionQuickAsks(filePath: string): Promise<QuickAskEntry[]> {
  return projectSessionQuickAsks(await readQuickAskRecords(filePath));
}
