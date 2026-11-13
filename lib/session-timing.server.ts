import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { findChildSessionPaths, sessionFilePathAliases } from "./billing";
import {
  analyzeTurns,
  computeSessionTiming,
  timingMessagesFromEntries,
  type ChildTimingSource,
  type SessionTimingInfo,
  type TimingEntry,
  type TimingInterval,
  type TimingMessage,
  type TimingQuality,
} from "./session-timing";

const READER_SUBAGENT_METADATA = "pi-web:subagent";
const READER_SUBAGENT_TOOL = "Agent";
const READER_SUBAGENT_NOTIFICATION = "pi-web:subagent-notification";
const PI_SUBAGENTS_TOOL = "subagent";
const PI_SUBAGENTS_NOTIFICATION = "subagent-notify";
const NON_LAUNCHING_SUBAGENT_ACTIONS = new Set([
  "children.list",
  "command.cancel",
  "command.status",
  "debug.run",
  "dismiss",
  "doctor",
  "get",
  "guide",
  "interrupt",
  "list",
  "models",
  "project.status",
  "status",
  "stop",
  "validate",
  "watchdog.check",
  "watchdog.configure",
  "watchdog.recommend-model",
  "watchdog.status",
]);
/** pi-subagents stores each run under `<parent child directory>/<run id>/run-<n>/session.jsonl`. */
const RUN_DIRECTORY = /^run-\d+$/;
const CHILD_RECORD_CACHE_LIMIT = 256;

interface ChildRecord {
  path: string;
  sessionId?: string;
  runId?: string;
  readerChild: boolean;
  messages: TimingMessage[];
  allMessages: TimingMessage[];
  quality: TimingQuality;
}

/** A subagent run referenced by an agent's launching tool result or completion notice. */
interface ChildReference {
  /** Run id, session file and session id keys; the first one groups launch and completion. */
  keys: string[];
  toolCallId?: string;
  messageIndex: number;
  launchAt?: number;
  fallbackWindow?: TimingInterval;
}

export interface SessionTimingRequest {
  filePath?: string | null;
  header?: { parentSession?: unknown; timestamp?: unknown } | null;
  /** Entries of the viewed branch, root to leaf. */
  branch: readonly TimingEntry[];
  /** All persisted entries, including other branches and later resumes. */
  entries?: readonly TimingEntry[];
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function selectBranch(entries: readonly TimingEntry[]): TimingEntry[] {
  const byId = new Map<string, TimingEntry>();
  for (const entry of entries) {
    const id = stringValue(entry.id);
    if (id) byId.set(id, entry);
  }
  let current = [...entries].reverse().find((entry) => stringValue(entry.id));
  const selected: TimingEntry[] = [];
  const seen = new Set<string>();
  while (current) {
    const id = stringValue(current.id);
    if (!id || seen.has(id)) break;
    seen.add(id);
    selected.push(current);
    const parentId = stringValue(current.parentId);
    current = parentId ? byId.get(parentId) : undefined;
  }
  selected.reverse();
  return selected.length > 0 ? selected : [...entries];
}

function parseChildRecord(path: string, content: string): ChildRecord {
  let quality: TimingQuality = content ? "complete" : "unavailable";
  let header: { id?: unknown; timestamp?: unknown; parentSession?: unknown } | undefined;
  let readerChild = false;
  const entries: TimingEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: (TimingEntry & { parentSession?: unknown }) | null;
    try {
      entry = JSON.parse(line);
    } catch {
      quality = "partial";
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.type === "session") {
      header = entry;
      continue;
    }
    if (entry.type === "custom" && entry.customType === READER_SUBAGENT_METADATA) readerChild = true;
    entries.push(entry);
  }
  // A child that inherited its parent's conversation counts only its own execution.
  const headerTime = parseTimestamp(header?.timestamp);
  const executionStart = (stringValue(header?.parentSession) || readerChild) && headerTime !== undefined ? headerTime : undefined;
  const runId = RUN_DIRECTORY.test(basename(dirname(path))) ? basename(dirname(dirname(path))) : undefined;
  const sessionId = stringValue(header?.id);
  return {
    path,
    ...(sessionId ? { sessionId } : {}),
    ...(runId ? { runId } : {}),
    readerChild,
    messages: timingMessagesFromEntries(selectBranch(entries), executionStart).messages,
    allMessages: timingMessagesFromEntries(entries, executionStart).messages,
    quality,
  };
}

const childRecordCache = new Map<string, { signature: string; record: ChildRecord }>();

async function readChildRecord(filePath: string): Promise<ChildRecord> {
  const path = resolve(filePath);
  let signature: string;
  try {
    const info = await stat(path);
    signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return { path, readerChild: false, messages: [], allMessages: [], quality: "unavailable" };
  }
  const cached = childRecordCache.get(path);
  if (cached?.signature === signature) return cached.record;
  const record = parseChildRecord(path, await readFile(path, "utf8").catch(() => ""));
  childRecordCache.delete(path);
  childRecordCache.set(path, { signature, record });
  if (childRecordCache.size > CHILD_RECORD_CACHE_LIMIT) childRecordCache.delete(childRecordCache.keys().next().value!);
  return record;
}

function firstTimestamp(messages: readonly TimingMessage[]): number | undefined {
  for (const message of messages) {
    const timestamp = parseTimestamp(message.displayTimestamp) ?? parseTimestamp(message.entryTimestamp) ?? parseTimestamp(message.timestamp);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function durationValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Run identities a pi-subagents result names: its run, a steering replacement, or its session files. */
function subagentRunKeys(details: Record<string, unknown>): string[] {
  const runId = stringValue(details.runId) ?? stringValue(details.asyncId);
  const replacement = stringValue(objectValue(details.steering)?.replacementRunId);
  const files = (Array.isArray(details.results) ? details.results : [])
    .flatMap((result) => stringValue(objectValue(result)?.sessionFile) ?? []);
  return [...(runId ? [`run:${runId}`] : []), ...(replacement ? [`run:${replacement}`] : []), ...files.map((file) => `file:${resolve(file)}`)];
}

function subagentCallActions(messages: readonly TimingMessage[]): Map<string, string | undefined> {
  const actions = new Map<string, string | undefined>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const call = objectValue(value);
      if (call?.type !== "toolCall") continue;
      const toolCallId = stringValue(call.toolCallId) ?? stringValue(call.id);
      const name = stringValue(call.toolName) ?? stringValue(call.name);
      if (!toolCallId || name !== PI_SUBAGENTS_TOOL) continue;
      actions.set(toolCallId, stringValue(objectValue(call.arguments ?? call.input)?.action));
    }
  }
  return actions;
}

/** A management action or a failed call does not start a child run. */
function startsNoRun(message: TimingMessage, keys: readonly string[], action?: string): boolean {
  const details = objectValue(message.details) ?? {};
  if (action && (NON_LAUNCHING_SUBAGENT_ACTIONS.has(action)
    || (action === "steer" && !stringValue(objectValue(details.steering)?.replacementRunId)))) return true;
  return keys.length === 0 && (message.isError === true || details.mode === "management");
}

function childLaunches(messages: readonly TimingMessage[]): Array<{ toolCallId: string; messageIndex: number; launchAt?: number; resume?: string; action?: string }> {
  const launches: Array<{ toolCallId: string; messageIndex: number; launchAt?: number; resume?: string; action?: string }> = [];
  const actions = subagentCallActions(messages);
  const idle = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolName !== PI_SUBAGENTS_TOOL) continue;
    const toolCallId = stringValue(message.toolCallId);
    const action = toolCallId ? actions.get(toolCallId) : undefined;
    if (toolCallId && startsNoRun(message, subagentRunKeys(objectValue(message.details) ?? {}), action)) idle.add(toolCallId);
  }
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const timestamp = parseTimestamp(message.timestamp);
    const duration = durationValue(message.durationMs);
    const launchAt = parseTimestamp(message.entryTimestamp) ?? (timestamp === undefined ? undefined : timestamp + (duration ?? 0));
    for (const value of message.content) {
      const call = objectValue(value);
      if (call?.type !== "toolCall") continue;
      const toolCallId = stringValue(call.toolCallId) ?? stringValue(call.id);
      const name = stringValue(call.toolName) ?? stringValue(call.name);
      if (!toolCallId || idle.has(toolCallId) || (name !== PI_SUBAGENTS_TOOL && name !== READER_SUBAGENT_TOOL)) continue;
      const resume = name === READER_SUBAGENT_TOOL ? stringValue(objectValue(call.arguments ?? call.input)?.resume) : undefined;
      const action = name === PI_SUBAGENTS_TOOL ? actions.get(toolCallId) : undefined;
      if (name === PI_SUBAGENTS_TOOL && action && NON_LAUNCHING_SUBAGENT_ACTIONS.has(action)) continue;
      launches.push({ toolCallId, messageIndex, ...(launchAt === undefined ? {} : { launchAt }), ...(resume ? { resume } : {}), ...(action ? { action } : {}) });
    }
  });
  return launches;
}

/** Subagent runs an agent started (launch results) or heard back from (completion notices). */
function childReferences(messages: readonly TimingMessage[]): ChildReference[] {
  const launches = childLaunches(messages);
  const actions = subagentCallActions(messages);
  const launchTimes = new Map(launches.map((item) => [item.toolCallId, item.launchAt]));
  const references: ChildReference[] = launches.flatMap((item) => item.resume
    ? [{ keys: [`session:${item.resume}`], toolCallId: item.toolCallId, messageIndex: item.messageIndex, ...(item.launchAt === undefined ? {} : { launchAt: item.launchAt }) }]
    : []);
  messages.forEach((message, messageIndex) => {
    const details = objectValue(message.details) ?? {};
    const toolCallId = message.role === "toolResult" ? stringValue(message.toolCallId) : undefined;
    const action = toolCallId ? actions.get(toolCallId) : undefined;
    const launchAt = toolCallId ? launchTimes.get(toolCallId) : undefined;
    if (message.role === "toolResult" && message.toolName === PI_SUBAGENTS_TOOL) {
      const keys = subagentRunKeys(details);
      if (startsNoRun(message, keys, action)) return;
      references.push({ keys, ...(toolCallId ? { toolCallId } : {}), messageIndex, ...(launchAt === undefined ? {} : { launchAt }) });
    } else if (message.role === "custom" && message.customType === PI_SUBAGENTS_NOTIFICATION) {
      const notifiedAt = parseTimestamp(message.timestamp) ?? parseTimestamp(message.entryTimestamp);
      for (const value of Array.isArray(details.runs) ? details.runs : []) {
        const run = objectValue(value);
        const runId = stringValue(run?.runId);
        const file = stringValue(run?.sessionValue);
        const keys = [...(runId ? [`run:${runId}`] : []), ...(file ? [`file:${resolve(file)}`] : [])];
        if (keys.length === 0) continue;
        const duration = durationValue(run?.durationMs);
        references.push({
          keys,
          messageIndex,
          ...(notifiedAt !== undefined && duration !== undefined ? { fallbackWindow: { start: notifiedAt - duration, end: notifiedAt } } : {}),
        });
      }
    } else if (
      details.kind === "pi-web-subagent"
      && ((message.role === "toolResult" && message.toolName === READER_SUBAGENT_TOOL)
        || (message.role === "custom" && message.customType === READER_SUBAGENT_NOTIFICATION))
    ) {
      const sessionId = stringValue(details.sessionId);
      if (!sessionId) return;
      const createdAt = parseTimestamp(details.createdAt);
      const completedAt = parseTimestamp(details.completedAt);
      references.push({
        keys: [`session:${sessionId}`],
        ...(toolCallId ? { toolCallId } : {}),
        messageIndex,
        ...(launchAt === undefined ? {} : { launchAt }),
        ...(createdAt !== undefined && completedAt !== undefined && completedAt >= createdAt ? { fallbackWindow: { start: createdAt, end: completedAt } } : {}),
      });
    }
  });
  return references;
}

/**
 * Load the viewed branch's timing with every subagent run it started. Child files may be in the
 * active or archived mirror of the parent's own child directory; a reference elsewhere is missing.
 */
export async function loadSessionTiming(request: SessionTimingRequest): Promise<SessionTimingInfo> {
  const forkedFrom = stringValue(request.header?.parentSession);
  const headerTime = parseTimestamp(request.header?.timestamp);
  const executionStart = forkedFrom && headerTime !== undefined ? headerTime : undefined;
  const parent = timingMessagesFromEntries(request.branch, executionStart);
  const allParent = timingMessagesFromEntries(request.entries ?? request.branch, executionStart);
  const records = request.filePath ? await Promise.all((await findChildSessionPaths(request.filePath)).map(readChildRecord)) : [];
  const recordsByKey = new Map<string, ChildRecord[]>();
  for (const record of records) {
    const keys = [
      ...sessionFilePathAliases(record.path).map((path) => `file:${path}`),
      ...(record.runId ? [`run:${record.runId}`] : []),
      ...(record.sessionId ? [`session:${record.sessionId}`] : []),
    ];
    for (const key of new Set(keys)) recordsByKey.set(key, [...(recordsByKey.get(key) ?? []), record]);
  }

  const children: ChildTimingSource[] = [];
  const linked = new Set<string>();
  const linkedRuns = new Set<string>();
  const pending: Array<{ messages: readonly TimingMessage[]; allMessages: readonly TimingMessage[]; parentId?: string }> = [
    { messages: parent.messages, allMessages: allParent.messages },
  ];
  const unresolved: Array<{ launch: ChildReference; keyed: boolean; hasWindow: boolean; matched: boolean }> = [];
  let missingChildRecords = 0;

  const visit = () => {
    while (pending.length > 0) {
      const current = pending.shift()!;
      const groups = new Map<string, ChildReference[]>();
      for (const reference of childReferences(current.messages)) {
        const key = reference.keys[0] ?? `anonymous:${reference.toolCallId ?? reference.messageIndex}`;
        groups.set(key, [...(groups.get(key) ?? []), reference]);
      }
      const allReferences = childReferences(current.allMessages);
      for (const [key, references] of groups) {
        const launch = references.find((reference) => reference.toolCallId) ?? references[0];
        const launchedBy = {
          ...(launch.toolCallId ? { launchToolCallId: launch.toolCallId } : {}),
          launchMessageIndex: launch.messageIndex,
        };
        const known = [...new Set(references.flatMap((reference) => reference.keys).flatMap((candidate) => recordsByKey.get(candidate) ?? []))];
        if (known.length === 0) {
          const keyed = launch.keys.length > 0;
          const fallbackWindow = references.find((reference) => reference.fallbackWindow)?.fallbackWindow;
          if (key.startsWith("session:")) {
            const selected = new Map(references.filter((item) => item.toolCallId).map((item) => [item.toolCallId!, item]));
            const allLaunches = allReferences.filter((item) => item.keys.includes(key) && item.toolCallId && item.launchAt !== undefined);
            for (const [callId, item] of selected) {
              const next = allLaunches.reduce<number | undefined>((earliest, other) => {
                if (item.launchAt === undefined || other.launchAt === undefined || other.launchAt <= item.launchAt) return earliest;
                return earliest === undefined ? other.launchAt : Math.min(earliest, other.launchAt);
              }, undefined);
              const direct = references.find((reference) => reference.toolCallId === callId && reference.fallbackWindow)?.fallbackWindow;
              const notices = references.filter((reference) => !reference.toolCallId && reference.fallbackWindow
                && item.launchAt !== undefined && reference.fallbackWindow.end >= item.launchAt
                && (next === undefined || reference.fallbackWindow.end < next)).map((reference) => reference.fallbackWindow!);
              const window = direct ?? (new Set(notices.map((notice) => notice.end)).size === 1 ? notices[0] : undefined);
              if (!window) continue;
              const start = Math.max(window.start, item.launchAt ?? window.start);
              if (window.end < start || (next !== undefined && window.end >= next)) continue;
              children.push({
                id: `missing:${key}#${callId}`, agentId: `missing:${key}`, ...(current.parentId ? { parentId: current.parentId } : {}),
                fallbackWindow: { start, end: window.end }, launchToolCallId: callId, launchMessageIndex: item.messageIndex, quality: "partial",
              });
            }
            if (selected.size === 0 && allLaunches.length === 0 && fallbackWindow) {
              children.push({ id: `missing:${key}`, ...(current.parentId ? { parentId: current.parentId } : {}), fallbackWindow, ...launchedBy, quality: "partial" });
            }
          } else if (fallbackWindow) {
            children.push({ id: `missing:${key}`, ...(current.parentId ? { parentId: current.parentId } : {}), fallbackWindow, ...launchedBy, quality: "partial" });
          }
          // A main-agent launch can still be settled by an unreferenced record of its turn below.
          if (!current.parentId) unresolved.push({ launch, keyed, hasWindow: Boolean(fallbackWindow) || key.startsWith("session:"), matched: false });
          else missingChildRecords += 1;
          continue;
        }
        for (const record of known) {
          if (key.startsWith("session:")) {
            const selected = new Map(references.filter((item) => item.toolCallId).map((item) => [item.toolCallId!, item]));
            const launches = new Map(allReferences.filter((item) => item.keys.includes(key) && item.toolCallId).map((item) => [item.toolCallId!, item]));
            for (const [id, item] of selected) if (!launches.has(id)) launches.set(id, item);
            if (selected.size === 0) {
              if (launches.size > 0 || linked.has(record.path)) continue;
              linked.add(record.path);
              const id = record.sessionId ?? record.path;
              children.push({ id, ...(current.parentId ? { parentId: current.parentId } : {}), messages: record.messages, ...launchedBy, quality: "partial" });
              pending.push({ messages: record.messages, allMessages: record.allMessages, parentId: id });
              continue;
            }
            const ordered = [...launches.values()].sort((a, b) => (a.launchAt ?? Infinity) - (b.launchAt ?? Infinity));
            const precise = ordered.every((item) => item.launchAt !== undefined)
              && new Set(ordered.map((item) => item.launchAt)).size === ordered.length;
            const assigned = new Map<string, TimingMessage[]>();
            let unassigned = false;
            for (const turn of analyzeTurns(record.messages)) {
              const segment = record.messages.slice(turn.userIndex, turn.endIndex);
              const startedAt = firstTimestamp(segment);
              const owner = precise && startedAt !== undefined
                ? ordered.filter((item) => item.launchAt! <= startedAt).at(-1)
                : ordered.length === 1 ? ordered[0] : undefined;
              if (!owner?.toolCallId) { unassigned = true; continue; }
              assigned.set(owner.toolCallId, [...(assigned.get(owner.toolCallId) ?? []), ...segment]);
            }
            linked.add(record.path);
            for (const [callId, item] of selected) {
              const runKey = `${record.path}\0${callId}`;
              if (linkedRuns.has(runKey)) continue;
              linkedRuns.add(runKey);
              const id = `${record.path}#${callId}`;
              const messages = assigned.get(callId) ?? [];
              children.push({
                id, agentId: record.path, ...(current.parentId ? { parentId: current.parentId } : {}), messages,
                launchToolCallId: callId, launchMessageIndex: item.messageIndex,
                quality: precise && !unassigned && messages.length > 0 ? record.quality : "partial",
              });
              pending.push({ messages, allMessages: record.allMessages, parentId: id });
            }
          } else {
            if (linked.has(record.path)) continue;
            linked.add(record.path);
            const id = record.sessionId ?? record.path;
            children.push({ id, ...(current.parentId ? { parentId: current.parentId } : {}), messages: record.messages, ...launchedBy, quality: record.quality });
            pending.push({ messages: record.messages, allMessages: record.allMessages, parentId: id });
          }
        }
      }
    }
  };
  visit();

  const turns = analyzeTurns(parent.messages);
  const branchCalls = new Set(turns.flatMap((turn) => turn.toolCallIds));
  const branchEntries = new Set(parent.entryIds);
  const isOtherBranch = (item: { messageIndex: number; toolCallId?: string }) => {
    const entryId = allParent.entryIds[item.messageIndex];
    return entryId ? !branchEntries.has(entryId) : !!item.toolCallId && !branchCalls.has(item.toolCallId);
  };
  const otherReferences = childReferences(allParent.messages).filter(isOtherBranch);
  const otherLaunches = childLaunches(allParent.messages).filter(isOtherBranch);
  const otherPaths = new Set(otherReferences.flatMap((item) => item.keys).flatMap((key) => (recordsByKey.get(key) ?? []).map((record) => record.path)));
  for (const turn of turns) {
    if (!turn.response) continue;
    // Only a turn that launched runs no reference identifies can own unreferenced records.
    const slots = unresolved
      .filter((item) => !item.hasWindow && turn.userIndex < item.launch.messageIndex && item.launch.messageIndex < turn.endIndex)
      .sort((left, right) => Number(left.keyed) - Number(right.keyed));
    if (slots.length === 0) continue;
    const candidates = records.filter((record) => {
      const startedAt = firstTimestamp(record.messages);
      return !linked.has(record.path) && !record.readerChild && !otherPaths.has(record.path)
        && startedAt !== undefined && turn.response!.start <= startedAt && startedAt <= turn.response!.end;
    });
    const competing = [...otherLaunches, ...otherReferences].some((item) => item.launchAt === undefined || (turn.response!.start <= item.launchAt && item.launchAt <= turn.response!.end));
    if (candidates.length === 0 || competing) continue;
    // Which launch produced which record is unknown, but the owning turn is not: every candidate counts
    // for this turn, and each settles at most one unidentified launch, run-less launches first.
    candidates.forEach((record, index) => {
      const slot = slots[Math.min(index, slots.length - 1)];
      if (index < slots.length) slot.matched = true;
      linked.add(record.path);
      const id = record.sessionId ?? record.path;
      children.push({ id, messages: record.messages, launchMessageIndex: slot.launch.messageIndex, ...(slot.launch.toolCallId ? { launchToolCallId: slot.launch.toolCallId } : {}), quality: "partial" });
      pending.push({ messages: record.messages, allMessages: record.allMessages, parentId: id });
    });
  }
  missingChildRecords += unresolved.filter((item) => !item.matched).length;
  visit();

  return computeSessionTiming({
    messages: parent.messages,
    entryIds: parent.entryIds,
    children,
    missingChildRecords,
    scope: forkedFrom ? "fork-execution" : "session",
  });
}
