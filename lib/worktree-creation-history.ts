import { isAbsolute, normalize, resolve } from "node:path";
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

function resolveCreationPath(rawPath: string, baseDir: string): string | undefined {
  if (!isAbsolute(baseDir)) return undefined;
  return normalize(isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath));
}

const READ_ONLY_REVISION_GUARD = /^test\s+"\$\(git\s+-C\s+"\$[A-Za-z_][A-Za-z0-9_]*"\s+rev-parse\s+[A-Za-z0-9._/-]+\)"\s*=\s*(?:"\$\(git\s+-C\s+"\$[A-Za-z_][A-Za-z0-9_]*"\s+rev-parse\s+[A-Za-z0-9._/-]+\)"|[A-Fa-f0-9]{40,64})\s*$/;
const PROJECT_ROOT_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)"|\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\))$/;

// shortcut: resolve only the read-only top-level query; do not evaluate arbitrary command substitutions.
function creationCommand(command: string, worktrees: ReadonlyMap<string, string> | null, home: string, sessionCwd: string, projectRoot: string): CreationCommand | undefined {
  // Multiple add commands cannot be paired unambiguously with one tool result.
  if ((command.match(/\bworktree\s+add\b/g) ?? []).length !== 1) return undefined;
  const variables = new Map<string, string>([["HOME", home]]);
  for (const fragment of commandFragments(command)) {
    const rootAssignment = PROJECT_ROOT_ASSIGNMENT.exec(fragment.trim());
    if (rootAssignment && isAbsolute(projectRoot)) {
      variables.set(rootAssignment[1], projectRoot);
      continue;
    }
    const parsed = splitShellWords(fragment.trim());
    if (!parsed.ok) {
      // A read-only revision guard runs in a subshell and cannot change these variables.
      if (parsed.error.code === "command-substitution" && READ_ONLY_REVISION_GUARD.test(fragment.trim())) continue;
      const homeValue = variables.get("HOME");
      variables.clear();
      if (homeValue !== undefined) variables.set("HOME", homeValue);
      continue;
    }
    if (parsed.words.length === 0) continue;
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
    let pathBase = sessionCwd;
    if (words[index] === "-C") {
      const gitDir = words[index + 1];
      if (gitDir === undefined) continue;
      const resolvedGitDir = resolveCreationPath(gitDir, sessionCwd);
      if (!resolvedGitDir) continue;
      pathBase = resolvedGitDir;
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
    const rawPath = words[index];
    if (!rawPath) return undefined;
    const path = resolveCreationPath(rawPath, pathBase);
    if (!path) return undefined;
    const registeredPath = worktrees?.get(path);
    if (worktrees && !registeredPath) return undefined;
    return {
      path: registeredPath ?? path,
      ...(branch ? { branch } : {}),
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
    && !/Command exited with code [1-9]/.test(output);
}

/** Project evidence from successful bash tool calls, not a current worktree owner. */
export function createWorktreeCreationCollector(
  session: Pick<SessionInfo, "id" | "created" | "cwd">,
  worktreePaths: readonly string[] | null,
  home: string,
  projectRoot = session.cwd,
) {
  const created = Date.parse(session.created);
  const worktrees = worktreePaths && new Map(worktreePaths.filter(isAbsolute).map((path) => [normalize(path), path]));
  const pending = new Map<string, CreationCommand & { createdAt: string }>();
  const found = new Map<string, WorktreeCreationRecord>();
  return {
    add(entry: SessionEntry) {
      if (!Number.isFinite(created) || entry.type !== "message") return;
      if (entry.message.role === "assistant") {
        const timestamp = Date.parse(entry.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < created) return;
        const message = normalizeToolCalls(entry.message);
        if (message.role !== "assistant") return;
        for (const block of message.content) {
          if (block.type !== "toolCall" || block.toolName !== "bash" || !block.toolCallId || typeof block.input.command !== "string") continue;
          const command = creationCommand(block.input.command, worktrees, home, session.cwd, projectRoot);
          if (command) {
            if (!worktrees && pending.has(block.toolCallId)) throw new Error("Ambiguous worktree creation call");
            if (!pending.has(block.toolCallId) && pending.size >= 4096) throw new Error("Too many pending worktree creation calls");
            pending.set(block.toolCallId, { ...command, createdAt: entry.timestamp });
          }
        }
      } else if (entry.message.role === "toolResult") {
        const command = pending.get(entry.message.toolCallId);
        pending.delete(entry.message.toolCallId);
        const resultTime = Date.parse(entry.timestamp);
        if (!command || entry.message.isError !== false || !Number.isFinite(resultTime) || resultTime < Date.parse(command.createdAt) || (entry.message.toolName && entry.message.toolName !== "bash")) return;
        const output = entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (confirmsCreation(output, command)) {
          if (!worktrees && !found.has(command.path) && found.size >= 4096) throw new Error("Too many worktree creation candidates");
          found.set(command.path, { worktreePath: command.path, sessionId: session.id, createdAt: command.createdAt });
        }
      }
    },
    records: () => [...found.values()],
  };
}

export function findWorktreeCreationRecords(
  entries: readonly SessionEntry[],
  session: Pick<SessionInfo, "id" | "created" | "cwd">,
  worktreePaths: readonly string[],
  home: string,
  projectRoot = session.cwd,
): WorktreeCreationRecord[] {
  const collector = createWorktreeCreationCollector(session, worktreePaths, home, projectRoot);
  for (const entry of entries) collector.add(entry);
  return collector.records();
}
