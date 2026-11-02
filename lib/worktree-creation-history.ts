import { isAbsolute, normalize } from "node:path";
import { normalizeToolCalls } from "./normalize";
import { shellAssignment, splitShellWords, type ShellWordPart } from "./shell-words";
import type { SessionEntry, SessionInfo } from "./types";

export interface WorktreeCreationRecord {
  worktreePath: string;
  sessionId: string;
  createdAt: string;
}

interface CreationCommand {
  path: string;
  branch?: string;
  usesVariables: boolean;
}

// Only recognize individual shell commands; never execute or evaluate history.
function commandFragments(input: string): string[] {
  const fragments: string[] = [];
  let heredoc: string | undefined;
  for (const line of input.split(/\r?\n/)) {
    if (heredoc) {
      if (line === heredoc) heredoc = undefined;
      continue;
    }
    if (line.includes("<<")) {
      const match = /<<\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
      if (!match) return [];
      heredoc = match[1] || match[2] || match[3];
      continue;
    }
    let quote: "'" | '"' | undefined;
    let escaped = false;
    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (escaped) { escaped = false; continue; }
      if (char === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) { if (char === quote) quote = undefined; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
        fragments.push(line.slice(start, index));
        start = line.length;
        break;
      }
      const operator = line.slice(index, index + 2);
      if (operator === "&&" || operator === "||" || char === ";") {
        fragments.push(line.slice(start, index));
        if (char !== ";") index += 1;
        start = index + 1;
      }
    }
    if (quote || escaped) return [];
    fragments.push(line.slice(start));
  }
  return heredoc ? [] : fragments;
}

function expandParts(parts: readonly ShellWordPart[], variables: ReadonlyMap<string, string>, assignment = false): string | undefined {
  let value = "";
  for (const part of parts) {
    if (part.type === "text") { value += part.value; continue; }
    const resolved = variables.get(part.name);
    if (resolved === undefined || part.fallback !== undefined) return undefined;
    if (!assignment && part.quote === "none" && /[\s*?[\]]/.test(resolved)) return undefined;
    value += resolved;
  }
  return value;
}

// shortcut: recognize a limited shell form, extend it only with equally verifiable execution evidence.
function creationCommand(command: string, worktrees: ReadonlyMap<string, string>, home: string): CreationCommand | undefined {
  // Multiple add commands cannot be paired unambiguously with one tool result.
  if ((command.match(/\bworktree\s+add\b/g) ?? []).length !== 1) return undefined;
  const variables = new Map<string, string>([["HOME", home]]);
  for (const fragment of commandFragments(command)) {
    const parsed = splitShellWords(fragment.trim());
    if (!parsed.ok || parsed.words.length === 0) continue;
    const assignment = parsed.words.length === 1 ? shellAssignment(parsed.words[0]) : undefined;
    if (assignment) {
      const value = expandParts(assignment.value, variables, true);
      if (value === undefined) variables.delete(assignment.name);
      else variables.set(assignment.name, value);
      continue;
    }
    const first = expandParts(parsed.words[0].parts, variables);
    if (["eval", "source", ".", "export", "unset", "read", "alias", "declare", "typeset"].includes(first ?? "")) return undefined;
    if (first !== "git") continue;
    const words = parsed.words.map((word) => expandParts(word.parts, variables));
    let index = 1;
    if (words[index] === "-C") {
      if (words[index + 1] === undefined) continue;
      index += 2;
    }
    if (words[index] !== "worktree" || words[index + 1] !== "add") continue;
    index += 2;
    let branch: string | undefined;
    while (words[index]?.startsWith("-")) {
      const option = words[index++];
      if (!option) return undefined;
      if (option === "--") break;
      if (option === "-b" || option === "-B") {
        branch = words[index++];
        if (!branch) return undefined;
      } else if (!["--detach", "--force", "-f", "--track", "--no-track"].includes(option)) {
        return undefined;
      }
    }
    const path = words[index];
    if (!path || !isAbsolute(path)) return undefined;
    const registeredPath = worktrees.get(normalize(path));
    if (!registeredPath) return undefined;
    return {
      path: registeredPath,
      ...(branch ? { branch } : {}),
      usesVariables: parsed.words[index].parts.some((part) => part.type === "variable"),
    };
  }
  return undefined;
}

function confirmsCreation(output: string, command: CreationCommand): boolean {
  const marker = command.branch
    ? `Preparing worktree (new branch '${command.branch}')`
    : "Preparing worktree (";
  const start = output.indexOf(marker);
  const head = output.indexOf("HEAD is now at ", start);
  return start >= 0 && head > start
    && (output.match(/Preparing worktree \(/g) ?? []).length === 1
    && !/\bfatal:/i.test(output.slice(start, head))
    && !/Command exited with code [1-9]/.test(output)
    && (!command.usesVariables || output.includes(command.path));
}

/** Project evidence from successful bash tool calls, not a current worktree owner. */
export function findWorktreeCreationRecords(
  entries: readonly SessionEntry[],
  session: Pick<SessionInfo, "id" | "created">,
  worktreePaths: readonly string[],
  home: string,
): WorktreeCreationRecord[] {
  const created = Date.parse(session.created);
  if (!Number.isFinite(created)) return [];
  const worktrees = new Map(worktreePaths.filter(isAbsolute).map((path) => [normalize(path), path]));
  const pending = new Map<string, CreationCommand & { createdAt: string }>();
  const found = new Map<string, WorktreeCreationRecord>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      const timestamp = Date.parse(entry.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < created) continue;
      const message = normalizeToolCalls(entry.message);
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type !== "toolCall" || block.toolName !== "bash" || !block.toolCallId || typeof block.input.command !== "string") continue;
        const command = creationCommand(block.input.command, worktrees, home);
        if (command) pending.set(block.toolCallId, { ...command, createdAt: entry.timestamp });
      }
    } else if (entry.message.role === "toolResult") {
      const command = pending.get(entry.message.toolCallId);
      pending.delete(entry.message.toolCallId);
      const resultTime = Date.parse(entry.timestamp);
      if (!command || entry.message.isError !== false || !Number.isFinite(resultTime) || resultTime < Date.parse(command.createdAt) || (entry.message.toolName && entry.message.toolName !== "bash")) continue;
      const output = entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (!confirmsCreation(output, command)) continue;
      found.set(command.path, { worktreePath: command.path, sessionId: session.id, createdAt: command.createdAt });
    }
  }
  return [...found.values()];
}
