import type { AgentMessage, AssistantMessage } from "./types";

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  costAvailable: boolean;
}

export function summarizeTurnUsage(
  messages: AgentMessage[],
  entryIds: string[],
  messageCosts: Record<string, number>,
  start = 0,
  end = messages.length,
): TurnUsage | undefined {
  const result: TurnUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costAvailable: true,
  };
  let hasUsage = false;

  for (let index = Math.max(0, start); index < Math.min(end, messages.length); index += 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const usage = (message as AssistantMessage).usage;
    if (!usage) continue;
    hasUsage = true;
    result.input += usage.input ?? 0;
    result.output += usage.output ?? 0;
    result.cacheRead += usage.cacheRead ?? 0;
    result.cacheWrite += usage.cacheWrite ?? 0;
    const calculatedCost = entryIds[index] ? messageCosts[entryIds[index]] : undefined;
    if (typeof calculatedCost === "number" && Number.isFinite(calculatedCost)) {
      result.cost.total += calculatedCost;
    } else {
      result.costAvailable = false;
    }
  }

  return hasUsage ? result : undefined;
}
