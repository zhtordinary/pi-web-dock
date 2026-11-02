import { randomUUID } from "node:crypto";
import { zhCNLocale } from "./i18n/messages/zh-CN.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { extractBase64ImageAttachment, MAX_ATTACHED_IMAGES, type Base64ImageAttachment } from "./image-attachments";

/** Room kept for the answer text of one Side Ask; reasoning is budgeted on top, because most APIs count it in the output limit. */
export const QUICK_ASK_ANSWER_TOKENS = 4096;
/** Window the SDK keeps free when it clamps an output limit (pi-ai api/simple-options CONTEXT_SAFETY_TOKENS). */
export const QUICK_ASK_WINDOW_RESERVE_TOKENS = 4096;
type ReasoningLevel = Parameters<typeof thinkingBudgetForLevel>[0];
const TURN_MARKER = "__piWebQuickAskTurn";

export class QuickAskError extends Error {
  constructor(message: string, public readonly status = 500) { super(message); this.name = "QuickAskError"; }
}

export function quickAskErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; error?: unknown; errorMessage?: unknown };
    if (typeof candidate.message === "string") return candidate.message;
    if (typeof candidate.errorMessage === "string") return candidate.errorMessage;
    if (typeof candidate.error === "string") return candidate.error;
  }
  return String(error);
}

export function parseQuickAskImages(value: unknown, field = "images"): Base64ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new QuickAskError(`${field} must be an array`, 400);
  if (value.length > MAX_ATTACHED_IMAGES) throw new QuickAskError(`${field} can include at most ${MAX_ATTACHED_IMAGES} images`, 400);
  const images = value.map(extractBase64ImageAttachment);
  if (images.some((image) => image === null)) throw new QuickAskError(`${field} contains invalid image data`, 400);
  return images.filter((image): image is Base64ImageAttachment => image !== null);
}

export function createQuickAskUserMessage(question: string, images: Base64ImageAttachment[]): UserMessage {
  return { role: "user", content: [
    ...(question ? [{ type: "text" as const, text: question }] : []),
    ...images.map((image) => ({ type: "image" as const, ...image })),
  ], timestamp: Date.now() };
}

/** Preserve extension context; a private marker, not text equality, identifies this turn. */
export function normalizeQuickAskContextMessages(messages: AgentMessage[], current: AgentMessage): AgentMessage[] {
  const marker = (current as AgentMessage & Record<string, unknown>)[TURN_MARKER];
  const matches = messages.flatMap((message, index) =>
    typeof marker === "string" && (message as AgentMessage & Record<string, unknown>)[TURN_MARKER] === marker ? [index] : []);
  if (!matches.length) return [...messages, current];
  const keep = matches[matches.length - 1];
  const tagged = new Set(matches);
  return messages.filter((_, index) => !tagged.has(index) || index === keep);
}

export async function prepareQuickAskContext(
  messages: AgentMessage[], transform: (messages: AgentMessage[]) => Promise<AgentMessage[]>,
): Promise<Context> {
  const copy = structuredClone(messages);
  const last = copy.at(-1);
  if (!last || last.role !== "user") throw new QuickAskError("Side Ask transcript must end with its current question");
  const current = Object.assign({}, last, { [TURN_MARKER]: randomUUID() });
  copy[copy.length - 1] = current;
  const transformed = normalizeQuickAskContextMessages(await transform(copy), current).map((message) => {
    if (!(TURN_MARKER in message)) return message;
    const { [TURN_MARKER]: _marker, ...clean } = message as AgentMessage & Record<string, unknown>;
    return clean as AgentMessage;
  });
  // The source owns initial prompt/tool adaptation. Never restore stale fields after extensions.
  return { messages: convertToLlm(transformed) };
}

/**
 * Output limit of one request, or a 413 when not even the answer fits. It uses the room the SDK would clamp to,
 * so the preflight and the request never disagree about what is left; reasoning gets what remains of its budget.
 */
export function resolveQuickAskOutputBudget(
  model: { contextWindow: number; maxTokens?: number; reasoning?: boolean }, context: Context, reasoning: ReasoningLevel | undefined,
): number {
  const cap = model.maxTokens && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
  const answer = Math.min(QUICK_ASK_ANSWER_TOKENS, cap);
  const wanted = Math.min(answer + (model.reasoning && reasoning ? thinkingBudgetForLevel(reasoning) : 0), cap);
  if (!(model.contextWindow > 0)) return wanted;
  const room = model.contextWindow - estimateContextTokens(normalizeContext(context)).tokens - QUICK_ASK_WINDOW_RESERVE_TOKENS;
  if (room < answer) {
    throw new QuickAskError(zhCNLocale.messages["sidekick.hostContextWindow"], 413);
  }
  return Math.min(wanted, room);
}
