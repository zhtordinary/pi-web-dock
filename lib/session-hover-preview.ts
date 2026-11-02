import { readSessionRecap, type SessionRecapSummary } from "./session-recap.ts";
import { isContinuationPrompt, isSubagentWakeText, SUBAGENT_WAKE_PREFIXES, textContent } from "./user-question.ts";
import { skillExpansionToCommand } from "./slash-display.ts";

export { isSubagentWakeText, SUBAGENT_WAKE_PREFIXES };

export type SessionHoverTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface SessionHoverTask {
  id: number;
  subject: string;
  status: SessionHoverTaskStatus;
  activeForm?: string;
}

export interface SessionHoverPreview {
  recap?: SessionRecapSummary;
  todos?: {
    tasks: SessionHoverTask[];
    nextId: number;
  };
}

export const SESSION_DISPLAY_INPUT_CUSTOM_TYPE = "pi-web:display-input";

function stripHiddenUserQuestionLines(raw: string): string {
  if (!raw) return "";
  return raw
    .split(/\r?\n/)
    .filter((line) => !isSubagentWakeText(line))
    .join("\n");
}

export function stripHiddenUserQuestion(raw: string): string {
  return stripHiddenUserQuestionLines(raw).trim();
}

export function stripHiddenUserQuestionPreservingWhitespace(raw: string): string {
  return stripHiddenUserQuestionLines(raw);
}

export function isSubagentWakeMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (!record || record.role !== "user") return false;
  const content = record.content;
  if (typeof content === "string") {
    return isSubagentWakeText(content) && stripHiddenUserQuestion(content) === "";
  }
  if (Array.isArray(content)) {
    const blocks = content.map(asRecord);
    if (blocks.some((block) => !block || block.type !== "text" || typeof block.text !== "string")) return false;
    const text = blocks.map((block) => block?.text as string).join("\n").trim();
    return isSubagentWakeText(text) && stripHiddenUserQuestion(text) === "";
  }
  return false;
}

type RecordValue = Record<string, unknown>;

export function sessionDisplayInputs(entries: Iterable<unknown>): ReadonlyMap<string, string> {
  const displayInputs = new Map<string, string>();
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (entry?.type !== "custom" || entry.customType !== SESSION_DISPLAY_INPUT_CUSTOM_TYPE) continue;
    const data = asRecord(entry.data);
    const targetEntryId = asTrimmedString(data?.targetEntryId);
    const input = typeof data?.input === "string" ? data.input : undefined;
    if (targetEntryId && input !== undefined) displayInputs.set(targetEntryId, input);
  }
  return displayInputs;
}

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" ? value as RecordValue : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Format a user question for preview:
 * - Restores SDK-expanded skill commands to their slash form
 * - Strips markdown images: ![...](...) and [image: ...]
 * - Discards blank/empty lines (not displayed and not counted towards line limit)
 * - Limits to maxLines non-empty lines (default 5)
 * - Appends "..." if there are additional lines
 */
export function formatUserQuestion(raw: string, maxLines = 5): string {
  const displayText = skillExpansionToCommand(raw) ?? raw;
  const cleaned = stripHiddenUserQuestion(
    displayText
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/\[image:[^\]]*\]/gi, ""),
  );
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}...`;
}

/** Return all non-continuation user questions from one active session branch. */
export function effectiveUserQuestions(entries: Iterable<unknown>): string[] {
  const entryList = Array.from(entries);
  const displayInputs = sessionDisplayInputs(entryList);

  const questions: string[] = [];
  for (const rawEntry of entryList) {
    const entry = asRecord(rawEntry);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "user") continue;
    const entryId = typeof entry.id === "string" ? entry.id : "";
    const rawText = displayInputs.get(entryId) ?? textContent(message.content);
    const text = stripHiddenUserQuestion(rawText);
    if (text && !isContinuationPrompt(text)) questions.push(text);
  }
  return questions;
}

function parseTask(value: unknown): SessionHoverTask | undefined {
  const record = asRecord(value);
  const id = record?.id;
  const subject = asTrimmedString(record?.subject);
  const status = record?.status;
  if (!Number.isSafeInteger(id) || typeof subject !== "string") return undefined;
  if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "deleted") return undefined;
  const activeForm = asTrimmedString(record?.activeForm);
  return {
    id: id as number,
    subject,
    status,
    ...(activeForm ? { activeForm } : {}),
  };
}

/** Read the latest persisted recap and rpiv-todo snapshot from one session branch. */
export function buildSessionHoverPreview(entries: Iterable<unknown>): SessionHoverPreview {
  let recap: SessionHoverPreview["recap"];
  let todos: SessionHoverPreview["todos"];

  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;

    recap = readSessionRecap(entry) ?? recap;

    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "toolResult" || message.toolName !== "todo") continue;
    const details = asRecord(message.details);
    const nextId = details?.nextId;
    if (!Number.isSafeInteger(nextId) || (nextId as number) < 1 || !Array.isArray(details?.tasks)) continue;
    const tasks = details.tasks.map(parseTask).filter((task): task is SessionHoverTask => Boolean(task));
    // Match rpiv-todo overlay semantics: tombstones stay in history but never
    // appear in the visible task panel.
    todos = { tasks: tasks.filter((task) => task.status !== "deleted"), nextId: nextId as number };
  }

  return {
    ...(recap ? { recap } : {}),
    ...(todos && todos.tasks.length > 0 ? { todos } : {}),
  };
}
