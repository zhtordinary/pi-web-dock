import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

function lastAssistantTermination(event: unknown): { stopReason: "aborted" | "error"; errorMessage?: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { type?: unknown; messages?: unknown };
  // SDK 1.1 puts the run-level aborted flag on `agent_settled`, not on
  // `agent_end`. The latter carries the assistant messages; only those
  // messages can describe an error/aborted assistant termination here.
  const messages = value.type === "agent_end" ? value.messages : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const assistant = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (assistant.role !== "assistant") continue;
    if (assistant.stopReason === "aborted") return { stopReason: "aborted" };
    if (assistant.stopReason === "error") {
      return {
        stopReason: "error",
        errorMessage: typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
          ? assistant.errorMessage.trim().slice(0, 280)
          : "agent ended with an error",
      };
    }
    return undefined;
  }
  return undefined;
}

export function agentEndErrorMessage(event: unknown): string | undefined {
  const termination = lastAssistantTermination(event);
  return termination?.stopReason === "error" ? termination.errorMessage : undefined;
}

export function agentEndWasAborted(event: unknown): boolean {
  return lastAssistantTermination(event)?.stopReason === "aborted";
}

type JsonMessageUpdateEvent = Extract<
  JsonAgentSessionEvent,
  { type: "message_update" }
>;

type JsonAssistantMessageEvent = JsonMessageUpdateEvent["assistantMessageEvent"];
type JsonToolCallStartEvent = Extract<JsonAssistantMessageEvent, { type: "toolcall_start" }>;
type JsonToolCallDeltaEvent = Extract<JsonAssistantMessageEvent, { type: "toolcall_delta" }>;

export type ClientAssistantMessageEvent =
  | Exclude<JsonAssistantMessageEvent, { type: "toolcall_start" | "toolcall_delta" }>
  | (JsonToolCallStartEvent & { id?: string; toolName?: string })
  | (JsonToolCallDeltaEvent & { id?: string; toolName?: string });

export type ClientMessageUpdateEvent = Omit<JsonMessageUpdateEvent, "assistantMessageEvent"> & {
  assistantMessageEvent: ClientAssistantMessageEvent;
};

const OMITTED_EVENT_TYPES = new Set([
  "turn_start",
  "turn_end",
  "entry_appended",
]);

export const CODEMODE_SNAPSHOT_CALL_LIMIT = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `tool_execution_*` event for a call that another tool made while it ran
 * (`ctx.executeTool()`, which codemode scripts use). The SDK gives those
 * `parentToolCallId` and ids of the form `<parent>/<n>`; the model never sees
 * them as tool calls, and the parent's own updates already report them.
 */
export function isNestedToolExecutionEvent(event: AgentEventLike): boolean {
  return (
    event.type === "tool_execution_start"
    || event.type === "tool_execution_update"
    || event.type === "tool_execution_end"
  ) && typeof event.parentToolCallId === "string" && event.parentToolCallId !== "";
}

/** Keep the newest calls of a codemode snapshot (`details.calls`) and count the rest. */
function truncateCodemodeSnapshot(partialResult: unknown): unknown {
  if (!isObject(partialResult) || !isObject(partialResult.details)) return partialResult;
  const calls = partialResult.details.calls;
  if (!Array.isArray(calls) || calls.length <= CODEMODE_SNAPSHOT_CALL_LIMIT) return partialResult;
  return {
    ...partialResult,
    details: {
      ...partialResult.details,
      calls: calls.slice(-CODEMODE_SNAPSHOT_CALL_LIMIT),
      omittedCalls: (typeof partialResult.details.omittedCalls === "number"
        && Number.isSafeInteger(partialResult.details.omittedCalls) && partialResult.details.omittedCalls > 0
        ? partialResult.details.omittedCalls : 0) + calls.length - CODEMODE_SNAPSHOT_CALL_LIMIT,
    },
  };
}

/**
 * Nested calls travel as a slim start and end, and their progress updates are
 * dropped. A `tool_execution_end` never carries `result`: the browser only
 * reads its ids and renders the tool result message that follows, while the
 * raw result can hold up to 1 MiB of bash output in `structuredContent`.
 */
function toClientToolExecutionEvent(event: AgentEventLike): AgentEventLike | null {
  const nested = isNestedToolExecutionEvent(event);
  if (event.type === "tool_execution_start") {
    if (!nested) return event;
    return {
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      parentToolCallId: event.parentToolCallId,
    };
  }
  if (event.type === "tool_execution_update") {
    if (nested) return null;
    return {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.toolName === "codemode"
        ? truncateCodemodeSnapshot(event.partialResult)
        : event.partialResult,
    };
  }
  return {
    type: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    isError: event.isError,
    ...(nested ? { parentToolCallId: event.parentToolCallId } : {}),
    ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
      ? { durationMs: event.durationMs }
      : {}),
  };
}

function terminalMetadata(event: AgentEventLike): { runId?: string; unattended?: boolean } {
  return {
    ...(typeof event.runId === "string" ? { runId: event.runId } : {}),
    ...(typeof event.unattended === "boolean" ? { unattended: event.unattended } : {}),
  };
}

function toolCallMetadata(
  event: Record<string, unknown>,
): { id: string; toolName: string } | null {
  if (
    (event.type !== "toolcall_start" && event.type !== "toolcall_delta")
    || !isObject(event.partial)
  ) return null;
  const content = event.partial.content;
  const contentIndex = event.contentIndex;
  if (!Array.isArray(content) || typeof contentIndex !== "number") return null;

  const block = content[contentIndex];
  if (!isObject(block) || block.type !== "toolCall") return null;
  const id = typeof block.id === "string"
    ? block.id
    : (typeof block.toolCallId === "string" ? block.toolCallId : null);
  const toolName = typeof block.name === "string"
    ? block.name
    : (typeof block.toolName === "string" ? block.toolName : null);
  return id !== null && toolName !== null ? { id, toolName } : null;
}

/** A `message_start` / `message_end` for a transcript system message (prompt and tool loadout). */
export function isSystemMessageEvent(event: AgentEventLike): boolean {
  return (event.type === "message_start" || event.type === "message_end")
    && isObject(event.message)
    && event.message.role === "system";
}

/** Apply pi-web's event filters plus Pi 0.84's message_update projection. */
export function toClientAgentEvent(
  event: AgentEventLike,
): AgentEventLike | ClientMessageUpdateEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  // Pi >= 0.86 appends the prompt and tool loadout to the transcript as system
  // messages, which the agent loop announces like any message. They carry the
  // whole prompt plus every tool schema and are never rendered, so drop them
  // before they cost the browser bandwidth.
  if (isSystemMessageEvent(event)) return null;

  if (event.type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent;
    if (
      typeof assistantMessageEvent !== "object"
      || assistantMessageEvent === null
      || Array.isArray(assistantMessageEvent)
    ) return null;

    if (!("partial" in assistantMessageEvent)) {
      return {
        type: "message_update",
        assistantMessageEvent,
      } as ClientMessageUpdateEvent;
    }

    const metadata = toolCallMetadata(assistantMessageEvent as Record<string, unknown>);
    const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
    void _partial;
    return {
      type: "message_update",
      assistantMessageEvent: metadata ? { ...deltaEvent, ...metadata } : deltaEvent,
    } as ClientMessageUpdateEvent;
  }

  if (event.type === "agent_end") {
    // Reader: surface the agent's final error (stopReason:error assistant
    // message) instead of dropping it - the client shows why the run ended.
    const errorMessage = agentEndErrorMessage(event);
    const aborted = agentEndWasAborted(event);
    const metadata = terminalMetadata(event);
    return {
      type: "agent_end",
      ...metadata,
      ...(aborted ? { aborted: true } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };
  }
  if (
    event.type === "tool_execution_start"
    || event.type === "tool_execution_update"
    || event.type === "tool_execution_end"
  ) return toClientToolExecutionEvent(event);

  return event;
}

export function isEventIncludedInSnapshot(
  event: AgentEventLike,
  snapshot: unknown,
): boolean {
  return snapshot !== undefined
    && (event.type === "message_start" || event.type === "message_update")
    && event.message === snapshot;
}
