import type { AgentMessage, AssistantMessage, ToolCallContent } from "./types";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function streamingRawInput(block: Record<string, unknown>): string | undefined {
  if (typeof block.rawInput === "string") return block.rawInput;
  if (typeof block.partialJson === "string") return block.partialJson;
  if (typeof block.partialArgs === "string") return block.partialArgs;

  const customInput = isObject(block.customInput) ? block.customInput : null;
  const property = customInput && typeof customInput.property === "string"
    ? customInput.property
    : null;
  const args = isObject(block.arguments) ? block.arguments : null;
  return property && args && typeof args[property] === "string"
    ? args[property]
    : undefined;
}

function normalizeToolCallBlock(
  block: unknown,
  options: { includeStreamingRawInput?: boolean } = {},
): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  const normalized: ToolCallContent = {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input: typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {}),
  };
  const rawInput = options.includeStreamingRawInput ? streamingRawInput(block) : undefined;
  return rawInput === undefined ? normalized : { ...normalized, rawInput };
}

function sanitizeAssistantContentBlock(
  block: unknown,
  options: { includeStreamingRawInput?: boolean } = {},
): unknown {
  const toolCall = normalizeToolCallBlock(block, options);
  if (toolCall) return toolCall;
  if (!isObject(block)) return block;

  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    return {
      type: "thinking",
      thinking: block.thinking,
      ...(block.deferred === true ? { deferred: true } : {}),
    };
  }
  return block;
}

function normalizeAssistantToolCalls(
  msg: AgentMessage,
  options: { includeStreamingRawInput?: boolean } = {},
): AgentMessage {
  // Assistant responses may carry provider-only signatures on content blocks.
  // They are needed for provider continuation, not for Reader rendering, and
  // retaining them makes every loaded history copy unnecessarily large.
  if (msg.role !== "assistant") return msg;
  const content = (msg as AssistantMessage).content;
  if (!Array.isArray(content)) return msg;
  const normalized = content.map((block) => sanitizeAssistantContentBlock(block, options));
  const sanitized = { ...msg, content: normalized } as AgentMessage & Record<string, unknown>;
  delete sanitized.thinkingSignature;
  delete sanitized.textSignature;
  return sanitized as AgentMessage;
}

export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  return normalizeAssistantToolCalls(msg);
}

export function normalizeStreamingToolCalls(msg: AgentMessage): AgentMessage {
  return normalizeAssistantToolCalls(msg, { includeStreamingRawInput: true });
}
