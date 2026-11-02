import type { AgentMessage, ToolResultMessage } from "./types";
import { pluginNameFromSource } from "./plugin-source.ts";
import type { ResourceSourceInfo } from "./pi-types.ts";
import { skillExpansionToCommand } from "./slash-display.ts";
import { CODEMODE_TOOL_NAME, codemodeCalls } from "./codemode-view.ts";

export interface TurnResourceCount {
  name: string;
  count: number;
}

export interface TurnSkillCount extends TurnResourceCount {
  path: string;
}

export interface TurnPluginCount extends TurnResourceCount {
  source: string;
  path: string;
  tools: TurnResourceCount[];
}

export interface TurnToolSource {
  name: string;
  sourceInfo?: ResourceSourceInfo;
}

export interface TurnResources {
  tools: TurnResourceCount[];
  nestedTools: TurnResourceCount[];
  omittedNestedCalls: number;
  skills: TurnSkillCount[];
  plugins: TurnPluginCount[];
}

/** Transcript evidence only: available runtime declarations are not usage. */
export function summarizeTurnResources(
  messages: readonly AgentMessage[],
  start = 0,
  end = messages.length,
  toolSources: readonly TurnToolSource[] = [],
): TurnResources {
  const tools = new Map<string, TurnResourceCount>();
  const nestedTools = new Map<string, TurnResourceCount>();
  const skills = new Map<string, TurnSkillCount>();
  const plugins = new Map<string, TurnPluginCount>();
  const toolSourceByName = new Map(toolSources.map((tool) => [tool.name, tool.sourceInfo]));
  const results = new Map<string, ToolResultMessage>();
  let omittedNestedCalls = 0;
  const turn = messages.slice(Math.max(0, start), Math.min(end, messages.length));
  for (const message of turn) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  const countTool = (counts: Map<string, TurnResourceCount>, name: string) => {
    const item = counts.get(name);
    if (item) item.count += 1;
    else counts.set(name, { name, count: 1 });
  };
  const countSkill = (name: string, path: string) => {
    const item = skills.get(path);
    if (item) item.count += 1;
    else skills.set(path, { name, path, count: 1 });
  };
  const countPlugin = (toolName: string) => {
    const sourceInfo = toolSourceByName.get(toolName);
    if (sourceInfo?.origin !== "package" || !sourceInfo.source) return;
    const key = `${sourceInfo.source}\u0000${sourceInfo.path}`;
    const plugin = plugins.get(key);
    if (plugin) {
      plugin.count += 1;
      const tool = plugin.tools.find((item) => item.name === toolName);
      if (tool) tool.count += 1;
      else plugin.tools.push({ name: toolName, count: 1 });
      return;
    }
    plugins.set(key, {
      name: pluginNameFromSource(sourceInfo.source),
      count: 1,
      source: sourceInfo.source,
      path: sourceInfo.path,
      tools: [{ name: toolName, count: 1 }],
    });
  };
  const countReadSkill = (name: string, input: unknown) => {
    // Only structured read calls identify a read; shell scripts and mentions
    // cannot establish which files were actually opened.
    if (name !== "read" && name !== "tools.read") return;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const args = input as Record<string, unknown>;
    const path = args.path ?? args.file_path;
    if (typeof path !== "string") return;
    const match = path.replaceAll("\\", "/").match(/(?:^|\/)([^/]+)\/SKILL\.md$/);
    if (match) countSkill(match[1], path);
  };

  for (const message of turn) {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (skillExpansionToCommand(text)) {
        const match = text.match(/^<skill name="([^"\n]+)" location="([^"\n]+)">/);
        if (match) countSkill(match[1], match[2]);
      }
    }
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall") continue;
      countTool(tools, block.toolName);
      countPlugin(block.toolName);
      const result = results.get(block.toolCallId);
      if (result && !result.isError) countReadSkill(block.toolName, block.input);
      if (block.toolName !== CODEMODE_TOOL_NAME) continue;
      const nested = codemodeCalls(result?.details);
      omittedNestedCalls += nested.omitted;
      for (const call of nested.calls) {
        countTool(nestedTools, call.name);
        countPlugin(call.name);
        if (call.status !== "ok") continue;
        const rawCalls = result?.details && typeof result.details === "object" && "calls" in result.details
          ? result.details.calls : null;
        // codemodeCalls defaults unknown statuses for display; a Skill load
        // requires an explicit successful execution record.
        if (!Array.isArray(rawCalls) || !rawCalls.some((raw) => raw && typeof raw === "object" && raw.name === call.name && raw.args === call.args && raw.status === "ok")) continue;
        let input: unknown;
        try { input = JSON.parse(call.args); } catch { continue; }
        countReadSkill(call.name, input);
      }
    }
  }
  return { tools: [...tools.values()], nestedTools: [...nestedTools.values()], omittedNestedCalls, skills: [...skills.values()], plugins: [...plugins.values()] };
}

/** A measured zero is distinct from a request that reports no prompt tokens. */
export function turnCacheHitRate(usage: { input: number; cacheRead: number; cacheWrite: number }): number | null {
  const { input, cacheRead, cacheWrite } = usage;
  if (![input, cacheRead, cacheWrite].every((value) => Number.isFinite(value) && value >= 0)) return null;
  const promptTokens = input + cacheRead + cacheWrite;
  return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : null;
}
