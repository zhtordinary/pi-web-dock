import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { normalizeToolCalls } from "./normalize";
import { shellAssignment, splitShellWords, type ShellWordPart } from "./shell-words";
import type { SessionEntry, SessionInfo } from "./types";

export interface WorktreeCreationRecord {
  worktreePath: string;
  sessionId: string;
  createdAt: string;
}

export interface WorktreeCreationEvidence {
  records: WorktreeCreationRecord[];
  uncertain: boolean;
}

export interface WorktreeCreationCommand {
  path: string;
  branch?: string;
}

export interface CreationInspection {
  command?: WorktreeCreationCommand;
  uncertain: boolean;
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

function isPathWithinProject(path: string, projectRoot: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(projectRoot)) return false;
  const child = relative(projectRoot, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/** Remove shell redirections without evaluating the command that contains them. */
function stripShellRedirections(input: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < input.length;) {
    const char = input[index];
    if (escaped) {
      result += char;
      escaped = false;
      index += 1;
      continue;
    }
    if (quote) {
      result += char;
      if (char === "\\" && quote === '"') escaped = true;
      else if (char === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      result += char;
      escaped = true;
      index += 1;
      continue;
    }

    let operatorIndex = index;
    while (operatorIndex < input.length && /[0-9]/.test(input[operatorIndex])) operatorIndex += 1;
    const hasFileDescriptor = operatorIndex > index && (index === 0 || /[\s;&|]/.test(input[index - 1]));
    if (!hasFileDescriptor) operatorIndex = index;
    const two = input.slice(operatorIndex, operatorIndex + 2);
    const one = input[operatorIndex];
    const operator = [">>", "<<", "<&", ">&", "<>"].includes(two) ? two
      : [">", "<", "&>"].includes(one) ? one : undefined;
    if (operator) {
      if (hasFileDescriptor) result = result.slice(0, -(operatorIndex - index));
      index = operatorIndex + operator.length;
      while (input[index] === " " || input[index] === "\t") index += 1;
      if (input[index] === "'" || input[index] === '"') {
        const redirectionQuote = input[index++];
        while (index < input.length) {
          const redirectionChar = input[index++];
          if (redirectionChar === "\\" && redirectionQuote === '"') index += 1;
          else if (redirectionChar === redirectionQuote) break;
        }
      } else {
        while (index < input.length && !/[\s;&|]/.test(input[index])) index += 1;
      }
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

const CONTROL_PREFIXES = new Set(["if", "then", "!", "do"]);
const CREATION_PREFIXES = new Set([...CONTROL_PREFIXES, "{", "("]);
const POTENTIAL_CREATION = /\bgit\b[^;&|]*\bworktree\s+add\b/;

function countCreationWords(words: readonly string[]): number {
  let count = 0;
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== "git") continue;
    if (index > 0 && !CREATION_PREFIXES.has(words[index - 1])) continue;
    let next = index + 1;
    if (words[next] === "-C") next += 2;
    if (words[next] === "worktree" && words[next + 1] === "add") count += 1;
  }
  return count;
}

function creationInvocationCount(command: string): number {
  const fragments = commandFragments(command);
  if (fragments.length === 0) return POTENTIAL_CREATION.test(stripShellRedirections(command)) ? 1 : 0;
  let count = 0;
  for (const fragment of fragments) {
    const sanitized = stripShellRedirections(fragment.trim());
    const parsed = splitShellWords(sanitized);
    if (parsed.ok) count += countCreationWords(parsed.words.map((word) => word.text));
    else if (POTENTIAL_CREATION.test(sanitized)) count += 1;
  }
  return count;
}

const READ_ONLY_REVISION_GUARD = /^test\s+"\$\(git\s+-C\s+"\$[A-Za-z_][A-Za-z0-9_]*"\s+rev-parse\s+[A-Za-z0-9._/-]+\)"\s*=\s*(?:"\$\(git\s+-C\s+"\$[A-Za-z_][A-Za-z0-9_]*"\s+rev-parse\s+[A-Za-z0-9._/-]+\)"|[A-Fa-f0-9]{40,64})\s*$/;
const READ_ONLY_STATUS_GUARD = /^test\s+-z\s+"\$\(git\s+-C\s+"\$[A-Za-z_][A-Za-z0-9_]*"\s+status\s+--porcelain=v1\s+--untracked-files=all\)"\s*$/;
const READ_ONLY_REVISION_PRINT = /^printf\s+'(?!-)(?:[^%'\\]|\\[nrt\\]|%%|%s)*'\s+"\$\(git\s+rev-parse\s+[A-Za-z0-9._/-]+(?:\s+[A-Za-z0-9._/-]+)*\)"\s*$/;
const PROJECT_ROOT_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)"|\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\))$/;

// shortcut: resolve only the read-only top-level query; do not evaluate arbitrary command substitutions.
function creationCommand(command: string, worktrees: ReadonlyMap<string, string> | null, home: string, sessionCwd: string, projectRoot: string): WorktreeCreationCommand | null | undefined {
  // Multiple add commands cannot be paired unambiguously with one tool result.
  if (creationInvocationCount(command) !== 1) return undefined;
  const variables = new Map<string, string>([["HOME", home]]);
  for (const fragment of commandFragments(command)) {
    const sanitized = stripShellRedirections(fragment.trim());
    if (/^(?:function\s+(?:printf|git)(?:\s*\(\s*\))?|(?:printf|git)\s*\(\s*\))\s*(?:\{|$)/.test(sanitized)) return undefined;
    const rootAssignment = PROJECT_ROOT_ASSIGNMENT.exec(sanitized);
    if (rootAssignment && isAbsolute(projectRoot)) {
      variables.set(rootAssignment[1], projectRoot);
      continue;
    }
    const parsed = splitShellWords(sanitized);
    if (!parsed.ok) {
      // These read-only substitutions cannot modify the parent shell's variables.
      if (parsed.error.code === "command-substitution"
        && (READ_ONLY_REVISION_GUARD.test(sanitized) || READ_ONLY_STATUS_GUARD.test(sanitized) || READ_ONLY_REVISION_PRINT.test(sanitized))) continue;
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
    let index = CONTROL_PREFIXES.has(first ?? "") ? 1 : 0;
    if (expandParts(parsed.words[index]?.parts ?? [], variables) !== "git") continue;
    index += 1;
    const words = parsed.words.map((word) => expandParts(word.parts, variables));
    let pathBase = sessionCwd;
    if (words[index] === "-C") {
      const gitDir = words[index + 1];
      if (gitDir === undefined) continue;
      const resolvedGitDir = resolveCreationPath(gitDir, sessionCwd);
      if (!resolvedGitDir) continue;
      pathBase = resolvedGitDir;
      index += 2;
    }
    if (!isPathWithinProject(pathBase, projectRoot)) return null;
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
      } else if (!["--detach", "--force", "-f", "--track", "--no-track", "--lock", "--orphan"].includes(option)) {
        return undefined;
      }
    }
    const rawPath = words[index];
    if (!rawPath) return undefined;
    const path = resolveCreationPath(rawPath, pathBase);
    if (!path) return undefined;
    const registeredPath = worktrees?.get(path);
    if (worktrees && !registeredPath) return null;
    return {
      path: registeredPath ?? path,
      ...(branch ? { branch } : {}),
    };
  }
  return undefined;
}

export function inspectWorktreeCreationCommand(
  command: string,
  worktreePaths: readonly string[] | null,
  home: string,
  sessionCwd: string,
  projectRoot = sessionCwd,
): CreationInspection {
  const worktrees = worktreePaths && new Map(worktreePaths.filter(isAbsolute).map((path) => [normalize(path), path]));
  if (creationInvocationCount(command) === 0) return { uncertain: false };
  const candidate = creationCommand(command, worktrees, home, sessionCwd, projectRoot);
  if (candidate === null) return { uncertain: false };
  if (!candidate) return { uncertain: true };
  return { command: candidate, uncertain: false };
}

export function confirmsWorktreeCreation(output: string, command: WorktreeCreationCommand): boolean {
  const markers = command.branch
    ? [
        `Preparing worktree (new branch '${command.branch}')`,
        `Preparing worktree (checking out '${command.branch}')`,
      ]
    : ["Preparing worktree ("];
  const start = markers.map((marker) => output.indexOf(marker)).find((index) => index >= 0) ?? -1;
  const head = output.indexOf("HEAD is now at ", start);
  return start >= 0 && head > start
    && (output.match(/Preparing worktree \(/g) ?? []).length === 1
    && !/\bfatal:/i.test(output.slice(start, head))
    && !/Command exited with code [1-9]/.test(output);
}

/**
 * Return a creator candidate only when Reader's own bash result and the
 * current Git inventory both verify one supported worktree creation.
 */
export function confirmedWorktreeCreationCommand(
  command: string,
  output: string,
  result: { exitCode?: number; cancelled?: boolean },
  worktreePaths: readonly string[] | null,
  home: string,
  sessionCwd: string,
  projectRoot = sessionCwd,
): WorktreeCreationCommand | undefined {
  if (result.exitCode !== 0 || result.cancelled === true) return undefined;
  const inspection = inspectWorktreeCreationCommand(command, worktreePaths, home, sessionCwd, projectRoot);
  if (inspection.uncertain || !inspection.command || !confirmsWorktreeCreation(output, inspection.command)) return undefined;
  return inspection.command;
}

/** Project evidence from successful bash calls, not a current worktree owner. */
export function createWorktreeCreationCollector(
  session: Pick<SessionInfo, "id" | "created" | "cwd">,
  worktreePaths: readonly string[] | null,
  home: string,
  projectRoot = session.cwd,
) {
  const created = Date.parse(session.created);
  const worktrees = worktreePaths && new Map(worktreePaths.filter(isAbsolute).map((path) => [normalize(path), path]));
  const pending = new Map<string, { command?: WorktreeCreationCommand; createdAt: string; uncertain: boolean }>();
  const found = new Map<string, WorktreeCreationRecord>();
  let uncertain = false;

  const rememberToolCall = (toolCallId: string, inspection: CreationInspection, createdAt: string): void => {
    if (pending.has(toolCallId)) {
      if (!worktrees) throw new Error("Ambiguous worktree creation call");
      uncertain = true;
      return;
    }
    if (!inspection.command && !inspection.uncertain) return;
    if (pending.size >= 4096) throw new Error("Too many pending worktree creation calls");
    pending.set(toolCallId, { ...(inspection.command ? { command: inspection.command } : {}), createdAt, uncertain: inspection.uncertain });
  };

  const record = (command: WorktreeCreationCommand, createdAt: string): void => {
    if (!worktrees && !found.has(command.path) && found.size >= 4096) throw new Error("Too many worktree creation candidates");
    found.set(command.path, { worktreePath: command.path, sessionId: session.id, createdAt });
  };

  return {
    add(entry: SessionEntry) {
      if (!Number.isFinite(created) || entry.type !== "message") return;
      const timestamp = Date.parse(entry.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < created) return;
      if (entry.message.role === "assistant") {
        const message = normalizeToolCalls(entry.message);
        if (message.role !== "assistant") return;
        for (const block of message.content) {
          if (block.type !== "toolCall" || block.toolName !== "bash" || !block.toolCallId || typeof block.input.command !== "string") continue;
          rememberToolCall(
            block.toolCallId,
            inspectWorktreeCreationCommand(block.input.command, worktreePaths, home, session.cwd, projectRoot),
            entry.timestamp,
          );
        }
        return;
      }
      if (entry.message.role === "bashExecution") {
        if (entry.message.exitCode !== 0 || entry.message.cancelled === true || typeof entry.message.command !== "string") return;
        const inspection = inspectWorktreeCreationCommand(entry.message.command, worktreePaths, home, session.cwd, projectRoot);
        if (!inspection.command) {
          if (inspection.uncertain) uncertain = true;
          return;
        }
        if (confirmsWorktreeCreation(entry.message.output, inspection.command)) record(inspection.command, entry.timestamp);
        else uncertain = true;
        return;
      }
      if (entry.message.role !== "toolResult") return;
      const pendingCreation = pending.get(entry.message.toolCallId);
      pending.delete(entry.message.toolCallId);
      if (!pendingCreation) return;
      const resultTime = Date.parse(entry.timestamp);
      const validResult = entry.message.isError === false
        && Number.isFinite(resultTime)
        && resultTime >= Date.parse(pendingCreation.createdAt)
        && (!entry.message.toolName || entry.message.toolName === "bash");
      if (!validResult) return;
      if (!pendingCreation.command) {
        uncertain = true;
        return;
      }
      const output = entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (confirmsWorktreeCreation(output, pendingCreation.command)) record(pendingCreation.command, pendingCreation.createdAt);
      else uncertain = true;
    },
    records: () => [...found.values()],
    evidence: (): WorktreeCreationEvidence => ({ records: [...found.values()], uncertain: uncertain || pending.size > 0 }),
  };
}

export function findWorktreeCreationEvidence(
  entries: readonly SessionEntry[],
  session: Pick<SessionInfo, "id" | "created" | "cwd">,
  worktreePaths: readonly string[],
  home: string,
  projectRoot = session.cwd,
): WorktreeCreationEvidence {
  const collector = createWorktreeCreationCollector(session, worktreePaths, home, projectRoot);
  for (const entry of entries) collector.add(entry);
  return collector.evidence();
}

export function findWorktreeCreationRecords(
  entries: readonly SessionEntry[],
  session: Pick<SessionInfo, "id" | "created" | "cwd">,
  worktreePaths: readonly string[],
  home: string,
  projectRoot = session.cwd,
): WorktreeCreationRecord[] {
  return findWorktreeCreationEvidence(entries, session, worktreePaths, home, projectRoot).records;
}
