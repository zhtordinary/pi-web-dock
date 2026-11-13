import { skillExpansionToCommand } from "./slash-display.ts";
import type { SessionInfo } from "./types.ts";

export function sessionDisplayTitle(session: Pick<SessionInfo, "id" | "name" | "firstMessage">, maxLength = 100): string {
  const named = session.name?.trim();
  if (named) return named.slice(0, maxLength);
  const displayMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const firstLine = displayMessage.trim().split(/\r?\n/, 1)[0]?.trim();
  return (firstLine || session.id).slice(0, maxLength);
}

export function sessionModelValue(
  session: Pick<SessionInfo, "modelName" | "relation">,
  preferred?: string,
): string | undefined {
  const candidates = [
    preferred,
    session.modelName,
    session.relation?.kind === "subagent" ? session.relation.model : undefined,
  ];
  return candidates.find((value): value is string => Boolean(value?.trim()))?.trim();
}

export function sessionModelLabel(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const segments = normalized.split("/").map((segment) => segment.trim()).filter(Boolean);
  return segments.at(-1) ?? normalized;
}
