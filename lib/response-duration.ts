import type { AgentMessage, AssistantMessage, CustomMessage } from "./types";
import { splitFinalAssistantBlocks } from "./message-display";

export function calculateResponseDurationMs(
  startTimestamp?: number,
  endTimestamp?: number,
): number | undefined {
  if (
    typeof startTimestamp !== "number"
    || typeof endTimestamp !== "number"
    || !Number.isFinite(startTimestamp)
    || !Number.isFinite(endTimestamp)
  ) return undefined;

  const duration = endTimestamp - startTimestamp;
  return duration >= 0 ? duration : undefined;
}

/** Pi 1.1 measures provider responses with a monotonic clock. Zero is valid. */
export function normalizeMeasuredDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function formatResponseDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";

  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;

  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts = [`${hours}h`];
  if (remainingMinutes > 0) parts.push(`${remainingMinutes}m`);
  if (remainingSeconds > 0) parts.push(`${remainingSeconds}s`);
  return parts.join(" ");
}

export function isCompactionMessage(message: AgentMessage): boolean {
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

/** Display groups of the conversation renderer; timing turns stay user-anchored across compactions. */
export function isResponseTurnAnchor(message: AgentMessage): boolean {
  return message.role === "user" || isCompactionMessage(message);
}

export function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

export function findFinalAssistantIndex(
  messages: readonly AgentMessage[],
  userIdx: number,
  endIdx: number,
): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}
