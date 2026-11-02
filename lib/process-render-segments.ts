import type { AgentMessage, AssistantMessage } from "./types.ts";
import { isSessionPeerAgentMessage } from "./session-peer-message.ts";
import { SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE } from "./session-control-display.ts";

export { SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE } from "./session-control-display.ts";

export function isSessionControlDisplayMessage(message: AgentMessage): boolean {
  if (isSessionPeerAgentMessage(message)) return true;
  return message.role === "custom" && message.customType === SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE;
}

export type ProcessDetailItem =
  | { kind: "message"; index: number }
  | { kind: "final"; index: number; message: AssistantMessage };

export type ProcessRenderSegment =
  | { kind: "details"; items: ProcessDetailItem[] }
  | { kind: "session-control"; index: number }
  | { kind: "answer"; index: number; message: AssistantMessage };

export function splitProcessRenderSegments(
  messages: AgentMessage[],
  visibleProcessIndices: number[],
  finalAssistantIdx: number,
  finalProcessMessage?: AssistantMessage | null,
  finalAnswerMessage?: AssistantMessage | null,
): ProcessRenderSegment[] {
  const segments: ProcessRenderSegment[] = [];
  let detailItems: ProcessDetailItem[] = [];
  const flushDetails = () => {
    if (detailItems.length === 0) return;
    segments.push({ kind: "details", items: detailItems });
    detailItems = [];
  };

  const items: ProcessDetailItem[] = visibleProcessIndices.map(index => ({ kind: "message", index }));
  if (finalProcessMessage) {
    const next = items.findIndex(item => item.index > finalAssistantIdx);
    items.splice(next < 0 ? items.length : next, 0, { kind: "final", index: finalAssistantIdx, message: finalProcessMessage });
  }
  let answer = finalAnswerMessage;
  for (const item of items) {
    if (answer && item.index > finalAssistantIdx) {
      flushDetails();
      segments.push({ kind: "answer", index: finalAssistantIdx, message: answer });
      answer = null;
    }
    if (item.kind === "message" && isSessionControlDisplayMessage(messages[item.index])) {
      flushDetails();
      segments.push({ kind: "session-control", index: item.index });
    } else detailItems.push(item);
  }
  flushDetails();
  if (answer) segments.push({ kind: "answer", index: finalAssistantIdx, message: answer });
  return segments;
}
