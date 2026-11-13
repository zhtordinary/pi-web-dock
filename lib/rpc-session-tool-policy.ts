import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveShellTools } from "./powershell-settings";
import { SUBAGENT_CONTROL_TOOL_NAMES } from "./subagents";
import type { AgentSessionLike, ToolInfo } from "./pi-types";

export const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
export const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const SESSION_TOOL_NAMES = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);

/** Resolve Reader's coding selection without hiding active extension tools. */
export function resolveActiveToolNames(
  session: AgentSessionLike,
  requested: readonly string[],
  carry: readonly string[],
): string[] {
  if (requested.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  const selectedToolNames = resolveShellTools(
    requested.filter((name) => codingToolNames.has(name)),
    session.settingsManager.getDefaultTools(),
  );
  const carriedToolNames = carry.filter((name) => {
    const tool = registered.get(name);
    const exposure = (tool as (ToolInfo & { exposure?: unknown }) | undefined)?.exposure;
    return tool !== undefined && !codingToolNames.has(name) && exposure !== "hidden";
  });

  return [...new Set([...selectedToolNames, ...carriedToolNames])];
}

/** Read the explicit thinking marker from the current persisted branch. */
export function readSessionThinkingLevel(sessionManager: SessionManager): ThinkingLevel | undefined {
  let level: ThinkingLevel | undefined;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type === "thinking_level_change") {
      level = entry.thinkingLevel as unknown as ThinkingLevel;
    }
  }
  return level;
}
