import type { AgentMessage } from "./types";
import { findFinalAssistantIndex, hasFinalAssistantAnswer, isCompactionMessage, normalizeMeasuredDurationMs } from "./response-duration";

export type TimingQuality = "complete" | "partial" | "unavailable";
export type TimingScope = "session" | "fork-execution";

/** Fields the timing model reads; persisted entries and rendered transcript messages share them. */
export interface TimingMessage {
  role?: unknown;
  timestamp?: unknown;
  entryTimestamp?: unknown;
  displayTimestamp?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  stopReason?: unknown;
  /** Pi monotonic duration: the request on an assistant, the execution on a tool result. */
  durationMs?: unknown;
  customType?: unknown;
  details?: unknown;
}

export interface TimingEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: TimingMessage;
  summary?: unknown;
  customType?: unknown;
  details?: unknown;
}

export interface TimingInterval {
  start: number;
  end: number;
}

/** Tools that wait for a person's answer; that time is not agent work. */
export const USER_INPUT_TOOL_NAMES: ReadonlySet<string> = new Set(["ask_user_question", "ask_user"]);
/** Tools that wait on a delegated subagent; overlap with the subagent's work is the subagent's time. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent", "Agent", "get_subagent_result"]);

/** One user-anchored turn of a single agent. A compaction stays inside the turn it interrupts. */
export interface TurnActivity {
  userIndex: number;
  /** Index of the next user message, or the message count. */
  endIndex: number;
  finalAssistantIndex: number;
  /** Question to final answer, or to the last agent activity when no answer was written. */
  response?: TimingInterval;
  /** Periods in which the agent's run loop was active, without waits for the user. */
  active: TimingInterval[];
  /** Model requests, failed attempts and compaction summaries. */
  model: TimingInterval[];
  tools: TimingInterval[];
  /** Subagent tool execution. */
  delegated: TimingInterval[];
  userWait: TimingInterval[];
  /** Backoff between a failed request and its automatic retry. */
  retryWait: TimingInterval[];
  toolCallIds: string[];
  /** False when the anchor or an assistant had no usable timestamp. */
  measurable: boolean;
}

export interface AgentTimingTotals {
  /** The agent's own working time. */
  agentMs: number;
  modelMs: number;
  toolMs: number;
  /** Working time that is neither model nor tool, including retry backoff. */
  otherMs: number;
  retryWaitMs: number;
  userWaitMs: number;
}

export interface ChildTimingSource {
  id: string;
  /** Stable identity shared by separate runs of the same child. */
  agentId?: string;
  /** Child that started this one; absent for children of the main agent. */
  parentId?: string;
  /** Timing messages of the child's selected branch; absent when its session record is gone. */
  messages?: readonly TimingMessage[];
  /** Run window recorded by the parent when the child's own record is gone. */
  fallbackWindow?: TimingInterval;
  /** Tool call of the parent agent that started the child. */
  launchToolCallId?: string;
  /** Parent message that referenced the child, for runs without a launching call on the branch. */
  launchMessageIndex?: number;
  quality: TimingQuality;
}

export interface SessionTimingSource {
  messages: readonly TimingMessage[];
  /** Persisted entry id of each message. */
  entryIds: readonly (string | undefined)[];
  children?: readonly ChildTimingSource[];
  /** Linked subagent runs whose session record no longer exists. */
  missingChildRecords?: number;
  scope?: TimingScope;
}

export interface SessionTurnTiming {
  /** Entry id of the user message that opened the turn. */
  entryId: string;
  responseMs: number;
  /** Model response time of the main agent plus the subagents this turn started. */
  modelResponseMs: number;
  /** Working time of the main agent plus the subagents this turn started. */
  agentTotalMs: number;
}

export interface SessionTimingInfo {
  /** Wall-clock time in which the main agent or an included subagent was working, without waits for the user. */
  effectiveMs: number;
  /** Every agent's own working time added up; waiting on a subagent counts only for that subagent. */
  agentTotalMs: number;
  /** Every agent's model requests added up, failed attempts and compaction summaries included. */
  modelResponseMs: number;
  /** modelResponseMs as a percentage of agentTotalMs. */
  modelResponsePercent?: number;
  toolMs: number;
  otherMs: number;
  retryWaitMs: number;
  userWaitMs: number;
  parent: { agentTotalMs: number; modelResponseMs: number };
  children: { count: number; agentTotalMs: number; modelResponseMs: number; missingRecords: number };
  turns: SessionTurnTiming[];
  quality: TimingQuality;
  scope: TimingScope;
  /** "window": `turns` covers only the transcript page it came with; the branch's full list comes from metadata. */
  turnsScope?: "window";
}

export interface AssistantTiming {
  modelWaitMs?: number;
  modelWaitQuality: TimingQuality;
  toolBatchMs?: number;
  toolBatchQuality: TimingQuality;
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

function unionIntervals(intervals: readonly TimingInterval[]): TimingInterval[] {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TimingInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) merged.push({ ...interval });
    else if (interval.end > previous.end) previous.end = interval.end;
  }
  return merged;
}

function intersectIntervals(left: readonly TimingInterval[], right: readonly TimingInterval[]): TimingInterval[] {
  const a = unionIntervals(left);
  const b = unionIntervals(right);
  const result: TimingInterval[] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) result.push({ start, end });
    if (a[i].end < b[j].end) i += 1;
    else j += 1;
  }
  return result;
}

function subtractIntervals(left: readonly TimingInterval[], right: readonly TimingInterval[]): TimingInterval[] {
  const removed = unionIntervals(right);
  const result: TimingInterval[] = [];
  let first = 0;
  for (const interval of unionIntervals(left)) {
    let start = interval.start;
    while (first < removed.length && removed[first].end <= start) first += 1;
    for (let index = first; index < removed.length && removed[index].start < interval.end; index += 1) {
      if (removed[index].start > start) result.push({ start, end: removed[index].start });
      start = Math.max(start, removed[index].end);
    }
    if (start < interval.end) result.push({ start, end: interval.end });
  }
  return result;
}

function intervalLength(intervals: readonly TimingInterval[]): number {
  return unionIntervals(intervals).reduce((total, interval) => total + interval.end - interval.start, 0);
}

export function timingPercent(part: number, total: number): number | undefined {
  return Number.isFinite(part) && Number.isFinite(total) && part >= 0 && total > 0 ? (part / total) * 100 : undefined;
}

function anchorTimestamp(message: TimingMessage | undefined): number | undefined {
  if (!message) return undefined;
  return parseTimestamp(message.displayTimestamp) ?? parseTimestamp(message.entryTimestamp) ?? parseTimestamp(message.timestamp);
}

function entryTime(message: TimingMessage): number | undefined {
  return parseTimestamp(message.entryTimestamp) ?? parseTimestamp(message.timestamp);
}

/** Request start to response end, sized by Pi's monotonic duration when it was measured. */
function requestInterval(message: TimingMessage): TimingInterval | undefined {
  const start = parseTimestamp(message.timestamp);
  const appended = parseTimestamp(message.entryTimestamp);
  const duration = normalizeMeasuredDurationMs(message.durationMs);
  if (duration !== undefined && (start !== undefined || appended !== undefined)) {
    // Both ends can only run late: a provider may stamp the message after its stream opened, and the
    // append can wait for extension handlers. The earlier one is closer to the real end.
    const end = Math.min(start === undefined ? Number.POSITIVE_INFINITY : start + duration, appended ?? Number.POSITIVE_INFINITY);
    return { start: end - duration, end };
  }
  if (start === undefined) return undefined;
  return appended !== undefined && appended >= start ? { start, end: appended } : undefined;
}

/** Tool execution; results without a measured duration span from the call's persistence to theirs. */
function executionInterval(result: TimingMessage, callPersistedAt: number | undefined): TimingInterval | undefined {
  const created = parseTimestamp(result.timestamp) ?? parseTimestamp(result.entryTimestamp);
  const duration = normalizeMeasuredDurationMs(result.durationMs);
  if (created !== undefined && duration !== undefined) return { start: created - duration, end: created };
  const appended = parseTimestamp(result.entryTimestamp);
  if (appended === undefined || callPersistedAt === undefined || appended < callPersistedAt) return undefined;
  return { start: callPersistedAt, end: appended };
}

function assistantToolCalls(content: unknown): Array<{ id: string; name?: string }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "toolCall") continue;
    const id = stringValue(record.toolCallId) ?? stringValue(record.id);
    if (id) calls.push({ id, name: stringValue(record.toolName) ?? stringValue(record.name) });
  }
  return calls;
}

/** Pi stops the run on a failed or aborted request, and after a response without tool calls. */
function endsRun(message: TimingMessage, hasToolCalls: boolean): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return true;
  return !hasToolCalls && message.stopReason !== "toolUse";
}

function analyzeTurn(messages: readonly TimingMessage[], userIndex: number, endIndex: number): TurnActivity {
  const turn: TurnActivity = {
    userIndex,
    endIndex,
    finalAssistantIndex: findFinalAssistantIndex(messages as readonly AgentMessage[], userIndex, endIndex),
    active: [],
    model: [],
    tools: [],
    delegated: [],
    userWait: [],
    retryWait: [],
    toolCallIds: [],
    measurable: true,
  };
  const start = anchorTimestamp(messages[userIndex]);
  if (start === undefined) {
    turn.measurable = false;
    return turn;
  }
  // A message sent while the agent works opens the next turn; time after it belongs there.
  const next = endIndex < messages.length ? anchorTimestamp(messages[endIndex]) : undefined;
  const limit = next !== undefined && next >= start ? next : undefined;

  const segments: TimingInterval[] = [];
  let current: TimingInterval = { start, end: start };
  let running = true;
  let failed = false;
  let trigger: number | undefined;
  let recovery: TimingInterval | undefined;
  const calls = new Map<string, { name?: string; persistedAt?: number }>();
  const extend = (time: number) => {
    if (time > current.end) current.end = time;
  };
  const resume = (at: number) => {
    if (running) return;
    if (failed && trigger === undefined) {
      // Pi retries a failed request after a backoff, compacting first when the context overflowed.
      if (recovery) {
        turn.model.push(recovery);
        extend(recovery.end);
      }
      if (at > current.end) turn.retryWait.push({ start: current.end, end: at });
      extend(at);
    } else {
      // A notification such as a background subagent's completion starts a new run; the idle gap
      // before it is not this agent's work.
      segments.push(current);
      const resumedAt = trigger !== undefined && trigger <= at ? trigger : at;
      current = { start: resumedAt, end: resumedAt };
    }
    running = true;
    failed = false;
    trigger = undefined;
    recovery = undefined;
  };

  for (let index = userIndex + 1; index < endIndex; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      const request = requestInterval(message);
      const requestStart = request?.start ?? entryTime(message);
      if (requestStart === undefined) {
        turn.measurable = false;
        continue;
      }
      resume(requestStart);
      if (request) {
        turn.model.push(request);
        extend(request.end);
      } else {
        turn.measurable = false;
        extend(requestStart);
      }
      const toolCalls = assistantToolCalls(message.content);
      const persistedAt = parseTimestamp(message.entryTimestamp) ?? request?.end;
      for (const call of toolCalls) {
        calls.set(call.id, { name: call.name, persistedAt });
        turn.toolCallIds.push(call.id);
      }
      if (endsRun(message, toolCalls.length > 0)) {
        running = false;
        failed = message.stopReason === "error";
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(stringValue(message.toolCallId) ?? "");
      const execution = executionInterval(message, call?.persistedAt);
      const finishedAt = execution?.end ?? entryTime(message);
      if (finishedAt === undefined) continue;
      resume(execution?.start ?? finishedAt);
      if (execution) {
        const name = stringValue(message.toolName) ?? call?.name ?? "";
        if (USER_INPUT_TOOL_NAMES.has(name)) turn.userWait.push(execution);
        else if (SUBAGENT_TOOL_NAMES.has(name)) turn.delegated.push(execution);
        else turn.tools.push(execution);
      }
      extend(finishedAt);
    } else if (isCompactionMessage(message as AgentMessage)) {
      const compactedAt = parseTimestamp(message.timestamp) ?? parseTimestamp(message.entryTimestamp);
      if (compactedAt === undefined) continue;
      if (running) {
        // Pi compacts between the steps of a long run; the summary request is model time.
        if (compactedAt > current.end) turn.model.push({ start: current.end, end: compactedAt });
        extend(compactedAt);
      } else if (failed && trigger === undefined && compactedAt > current.end) {
        recovery = { start: current.end, end: compactedAt };
      }
    } else if (message.role === "custom" && !running && trigger === undefined) {
      trigger = parseTimestamp(message.timestamp) ?? parseTimestamp(message.entryTimestamp);
    }
  }
  segments.push(current);

  const bounded = limit === undefined ? unionIntervals(segments) : intersectIntervals(segments, [{ start, end: limit }]);
  turn.userWait = intersectIntervals(turn.userWait, bounded);
  turn.active = subtractIntervals(bounded, turn.userWait);
  turn.model = intersectIntervals(turn.model, turn.active);
  turn.tools = subtractIntervals(intersectIntervals(turn.tools, turn.active), turn.model);
  turn.delegated = subtractIntervals(intersectIntervals(turn.delegated, turn.active), turn.model);
  turn.retryWait = intersectIntervals(turn.retryWait, turn.active);

  if (turn.finalAssistantIndex >= 0) {
    const final = messages[turn.finalAssistantIndex];
    let end: number | undefined;
    if (hasFinalAssistantAnswer(final as AgentMessage)) {
      end = requestInterval(final)?.end ?? entryTime(final);
    } else {
      end = bounded.at(-1)?.end ?? start;
    }
    if (end !== undefined) {
      const responseEnd = limit === undefined ? end : Math.min(end, limit);
      if (responseEnd >= start) turn.response = { start, end: responseEnd };
    }
  }
  return turn;
}

/** Split an agent's messages into user-anchored turns. */
export function analyzeTurns(messages: readonly TimingMessage[]): TurnActivity[] {
  const turns: TurnActivity[] = [];
  for (let userIndex = 0; userIndex < messages.length;) {
    if (messages[userIndex]?.role !== "user") {
      userIndex += 1;
      continue;
    }
    let endIndex = userIndex + 1;
    while (endIndex < messages.length && messages[endIndex]?.role !== "user") endIndex += 1;
    turns.push(analyzeTurn(messages, userIndex, endIndex));
    userIndex = endIndex;
  }
  return turns;
}

/** Totals of an agent's turns; `delegatedTo` holds the working windows of its subagents. */
export function summarizeTurns(turns: readonly TurnActivity[], delegatedTo: readonly TimingInterval[] = []): AgentTimingTotals {
  const covered = unionIntervals(delegatedTo);
  const totals: AgentTimingTotals = { agentMs: 0, modelMs: 0, toolMs: 0, otherMs: 0, retryWaitMs: 0, userWaitMs: 0 };
  for (const turn of turns) {
    const own = subtractIntervals(turn.active, intersectIntervals(turn.delegated, covered));
    const agentMs = intervalLength(own);
    const modelMs = intervalLength(intersectIntervals(turn.model, own));
    const toolMs = intervalLength(intersectIntervals([...turn.tools, ...turn.delegated], own));
    totals.agentMs += agentMs;
    totals.modelMs += modelMs;
    totals.toolMs += toolMs;
    totals.otherMs += Math.max(0, agentMs - modelMs - toolMs);
    totals.retryWaitMs += intervalLength(intersectIntervals(turn.retryWait, own));
    totals.userWaitMs += intervalLength(turn.userWait);
  }
  return totals;
}

function addTotals(items: readonly AgentTimingTotals[]): AgentTimingTotals {
  return items.reduce((sum, item) => ({
    agentMs: sum.agentMs + item.agentMs,
    modelMs: sum.modelMs + item.modelMs,
    toolMs: sum.toolMs + item.toolMs,
    otherMs: sum.otherMs + item.otherMs,
    retryWaitMs: sum.retryWaitMs + item.retryWaitMs,
    userWaitMs: sum.userWaitMs + item.userWaitMs,
  }), { agentMs: 0, modelMs: 0, toolMs: 0, otherMs: 0, retryWaitMs: 0, userWaitMs: 0 });
}

function timingMessageForEntry(entry: TimingEntry, timestamp: number | undefined): TimingMessage | undefined {
  if (entry.type === "message" && entry.message) {
    if (entry.message.role === "system") return undefined;
    return {
      ...entry.message,
      ...(timestamp === undefined ? {} : {
        entryTimestamp: timestamp,
        ...(entry.message.role === "user" ? { displayTimestamp: timestamp } : {}),
      }),
    };
  }
  if (entry.type === "compaction") return { role: "custom", customType: "compaction", timestamp };
  if (entry.type === "branch_summary") {
    return typeof entry.summary === "string" && entry.summary.trim() ? { role: "user", timestamp } : undefined;
  }
  if (entry.type === "custom_message") return { role: "custom", customType: entry.customType, details: entry.details, timestamp };
  return undefined;
}

/** Map branch entries to timing messages, dropping history inherited before a fork's execution. */
export function timingMessagesFromEntries(
  entries: readonly TimingEntry[],
  executionStartTimestamp?: number,
): { messages: TimingMessage[]; entryIds: (string | undefined)[] } {
  const messages: TimingMessage[] = [];
  const entryIds: (string | undefined)[] = [];
  for (const entry of entries) {
    const timestamp = parseTimestamp(entry.timestamp);
    if (executionStartTimestamp !== undefined && timestamp !== undefined && timestamp < executionStartTimestamp) continue;
    const message = timingMessageForEntry(entry, timestamp);
    if (!message) continue;
    messages.push(message);
    entryIds.push(stringValue(entry.id));
  }
  return { messages, entryIds };
}

/** Keep the aggregates but only the turns opened inside a transcript page, so the page stays bounded. */
export function windowSessionTiming(timing: SessionTimingInfo, entryIds: readonly string[]): SessionTimingInfo {
  const page = new Set(entryIds);
  return { ...timing, turns: timing.turns.filter((turn) => page.has(turn.entryId)), turnsScope: "window" };
}

/** Compute the session's timing from the main agent's branch and the subagents it started. */
export function computeSessionTiming(source: SessionTimingSource): SessionTimingInfo {
  const parentTurns = analyzeTurns(source.messages);
  const children = (source.children ?? []).map((child) => {
    const turns = child.messages ? analyzeTurns(child.messages) : [];
    const windows = child.messages ? turns.flatMap((turn) => turn.active) : child.fallbackWindow ? [child.fallbackWindow] : [];
    return { child, turns, windows };
  });
  const byId = new Map(children.map((item) => [item.child.id, item]));
  const childrenOf = new Map<string | undefined, typeof children>();
  for (const item of children) {
    const parentId = item.child.parentId !== undefined && byId.has(item.child.parentId) ? item.child.parentId : undefined;
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), item]);
  }
  const descendantWindows = (id: string | undefined): TimingInterval[] => {
    const windows: TimingInterval[] = [];
    const pending = [...(childrenOf.get(id) ?? [])];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const item = pending.pop()!;
      if (seen.has(item.child.id)) continue;
      seen.add(item.child.id);
      windows.push(...item.windows);
      pending.push(...(childrenOf.get(item.child.id) ?? []));
    }
    return windows;
  };

  const covered = descendantWindows(undefined);
  const parentTurnTotals = parentTurns.map((turn) => summarizeTurns([turn], covered));
  const parentTotals = addTotals(parentTurnTotals);
  const childTotals = children.map((item) => {
    if (item.child.messages) return summarizeTurns(item.turns, descendantWindows(item.child.id));
    // Without the child's record only its run window is known.
    const agentMs = intervalLength(item.windows);
    return { agentMs, modelMs: 0, toolMs: 0, otherMs: agentMs, retryWaitMs: 0, userWaitMs: 0 };
  });
  const childSum = addTotals(childTotals);
  const totals = addTotals([parentTotals, childSum]);

  const turnByToolCall = new Map<string, number>();
  parentTurns.forEach((turn, index) => {
    for (const id of turn.toolCallIds) turnByToolCall.set(id, index);
  });
  const launchingTurn = (item: (typeof children)[number]): number | undefined => {
    let root = item;
    const seen = new Set<string>();
    while (root.child.parentId !== undefined && byId.has(root.child.parentId) && !seen.has(root.child.id)) {
      seen.add(root.child.id);
      root = byId.get(root.child.parentId)!;
    }
    const byCall = root.child.launchToolCallId === undefined ? undefined : turnByToolCall.get(root.child.launchToolCallId);
    if (byCall !== undefined) return byCall;
    const at = root.child.launchMessageIndex;
    if (at === undefined) return undefined;
    const index = parentTurns.findIndex((turn) => turn.userIndex < at && at < turn.endIndex);
    return index >= 0 ? index : undefined;
  };
  const childrenByTurn = parentTurns.map(() => ({ agentMs: 0, modelMs: 0 }));
  children.forEach((item, index) => {
    const turnIndex = launchingTurn(item);
    if (turnIndex === undefined) return;
    childrenByTurn[turnIndex].agentMs += childTotals[index].agentMs;
    childrenByTurn[turnIndex].modelMs += childTotals[index].modelMs;
  });
  const turns: SessionTurnTiming[] = [];
  parentTurns.forEach((turn, index) => {
    const entryId = source.entryIds[turn.userIndex];
    if (!entryId || !turn.response) return;
    turns.push({
      entryId,
      responseMs: turn.response.end - turn.response.start,
      modelResponseMs: parentTurnTotals[index].modelMs + childrenByTurn[index].modelMs,
      agentTotalMs: parentTurnTotals[index].agentMs + childrenByTurn[index].agentMs,
    });
  });

  const missingRecords = source.missingChildRecords ?? 0;
  const partial = missingRecords > 0
    || parentTurns.some((turn) => !turn.measurable || !turn.response)
    || children.some((item) => item.child.quality !== "complete"
      || (item.child.messages !== undefined && item.turns.length === 0)
      || item.turns.some((turn) => !turn.measurable || !turn.response));
  const percent = timingPercent(totals.modelMs, totals.agentMs);
  return {
    effectiveMs: intervalLength([...parentTurns.flatMap((turn) => turn.active), ...children.flatMap((item) => item.windows)]),
    agentTotalMs: totals.agentMs,
    modelResponseMs: totals.modelMs,
    ...(percent === undefined ? {} : { modelResponsePercent: percent }),
    toolMs: totals.toolMs,
    otherMs: totals.otherMs,
    retryWaitMs: totals.retryWaitMs,
    userWaitMs: totals.userWaitMs,
    parent: { agentTotalMs: parentTotals.agentMs, modelResponseMs: parentTotals.modelMs },
    children: { count: new Set(children.map((item) => item.child.agentId ?? item.child.id)).size, agentTotalMs: childSum.agentMs, modelResponseMs: childSum.modelMs, missingRecords },
    turns,
    quality: !parentTurns.some((turn) => turn.response) ? "unavailable" : partial ? "partial" : "complete",
    scope: source.scope ?? "session",
  };
}

/** Question-to-answer time of every turn, for cross-session usage summaries. */
export function computeSessionTotalActiveMs(entries: readonly TimingEntry[]): number {
  return analyzeTurns(timingMessagesFromEntries(entries).messages)
    .reduce((total, turn) => total + (turn.response ? turn.response.end - turn.response.start : 0), 0);
}

function orderedInterval(start: unknown, end: unknown): { interval?: TimingInterval; quality: TimingQuality } {
  const startMs = parseTimestamp(start);
  const endMs = parseTimestamp(end);
  if (startMs === undefined || endMs === undefined) {
    return { quality: "unavailable" };
  }
  if (endMs < startMs) return { quality: "partial" };
  return { interval: { start: startMs, end: endMs }, quality: "complete" };
}

function measuredInterval(message: TimingMessage): { interval?: TimingInterval; quality: TimingQuality } {
  const startMs = parseTimestamp(message.timestamp);
  const durationMs = normalizeMeasuredDurationMs(message.durationMs);
  if (startMs !== undefined && durationMs !== undefined) {
    return { interval: { start: startMs, end: startMs + durationMs }, quality: "complete" };
  }
  return orderedInterval(message.timestamp, message.entryTimestamp);
}

function readToolCallIds(content: unknown): { ids: string[]; malformed: boolean } {
  if (!Array.isArray(content)) return { ids: [], malformed: false };
  const ids: string[] = [];
  let malformed = false;
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type !== "toolCall") continue;
    const id = stringValue(block.toolCallId) ?? stringValue(block.id);
    if (!id || ids.includes(id)) {
      malformed = true;
      continue;
    }
    ids.push(id);
  }
  return { ids, malformed };
}

/** One assistant entry's model wait and tool batch for its own row. Tool results must contain one result per call. */
export function computeAssistantTiming(
  assistant: TimingMessage,
  toolResults: readonly TimingMessage[] = [],
): AssistantTiming {
  // Prefer Pi 1.1's monotonic duration over the JSONL append-time estimate;
  // legacy messages retain the existing timestamp fallback.
  const { ids, malformed: malformedCalls } = readToolCallIds(assistant.content);
  const model = measuredInterval(assistant);
  const result: AssistantTiming = {
    ...(model.interval ? { modelWaitMs: model.interval.end - model.interval.start } : {}),
    modelWaitQuality: model.quality,
    toolBatchQuality: ids.length === 0 && !malformedCalls ? "unavailable" : "partial",
  };
  if (malformedCalls || ids.length === 0) return result;

  const assistantEnd = parseTimestamp(assistant.entryTimestamp);
  if (assistantEnd === undefined) return result;

  const expected = new Set(ids);
  const seen = new Set<string>();
  let malformedResults = false;
  let previousResultTimestamp: number | undefined;
  let lastResultTimestamp: number | undefined;
  for (const rawResult of toolResults) {
    if (rawResult.role !== undefined && rawResult.role !== "toolResult") {
      malformedResults = true;
      continue;
    }
    const id = stringValue(rawResult.toolCallId);
    const timestamp = parseTimestamp(rawResult.entryTimestamp);
    if (!id || !expected.has(id) || seen.has(id) || timestamp === undefined) {
      malformedResults = true;
      continue;
    }
    if (timestamp < assistantEnd || (previousResultTimestamp !== undefined && timestamp <= previousResultTimestamp)) {
      malformedResults = true;
    }
    seen.add(id);
    previousResultTimestamp = timestamp;
    lastResultTimestamp = timestamp;
  }

  if (malformedResults || seen.size !== ids.length || lastResultTimestamp === undefined) return result;
  result.toolBatchMs = lastResultTimestamp - assistantEnd;
  result.toolBatchQuality = "complete";
  return result;
}
