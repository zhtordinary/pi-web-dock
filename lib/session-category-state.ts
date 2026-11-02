import { withStateFileTransaction } from "./state-file-transaction.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { emitActivityEvent } from "./activity-events.ts";

export type SessionStorageCategory = "to_discuss" | "to_revise" | "completed";

export interface SessionCategoryState {
  to_discuss: string[];
  to_revise: string[];
  completed: string[];
}

/** Resolve one session's canonical category from a normalized state snapshot. */
export function sessionCategoryFromState(state: SessionCategoryState, sessionId: string): SessionStorageCategory | undefined {
  const id = sessionId.trim();
  if (!id) return undefined;
  if (state.to_discuss.includes(id)) return "to_discuss";
  if (state.to_revise.includes(id)) return "to_revise";
  if (state.completed.includes(id)) return "completed";
  return undefined;
}

/**
 * Filter a session-like list by one storage category. `null` means the normal
 * view: only sessions without a storage category are included.
 */
export function filterSessionsByCategory<T extends { id: string }>(
  sessions: readonly T[],
  state: SessionCategoryState,
  category: SessionStorageCategory | null,
): T[] {
  return sessions.filter((session) => (sessionCategoryFromState(state, session.id) ?? null) === category);
}

export const SESSION_CATEGORIES_FILE = process.env.PI_WEB_SESSION_CATEGORIES_FILE
  ?? join(process.env.HOME ?? ".", ".config", "pi-web-reader", "session-categories.json");

const EMPTY: SessionCategoryState = {
  to_discuss: [],
  to_revise: [],
  completed: [],
};

declare global {
  var __piSessionCategoryStateCache: SessionCategoryState | undefined;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
}

function normalize(value: unknown): SessionCategoryState {
  if (!value || typeof value !== "object") return { ...EMPTY };
  const raw = value as { to_discuss?: unknown; to_revise?: unknown; completed?: unknown };
  return {
    to_discuss: normalizeList(raw.to_discuss),
    to_revise: normalizeList(raw.to_revise),
    completed: normalizeList(raw.completed),
  };
}

function load(): SessionCategoryState {
  let next = { ...EMPTY };
  try {
    next = normalize(JSON.parse(readFileSync(SESSION_CATEGORIES_FILE, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  globalThis.__piSessionCategoryStateCache = next;
  return next;
}

function persist(next: SessionCategoryState): void {
    mkdirSync(dirname(SESSION_CATEGORIES_FILE), { recursive: true });
    writePrivateFileAtomicSync(SESSION_CATEGORIES_FILE, `${JSON.stringify({ schemaVersion: 1, ...next }, null, 2)}\n`);
  globalThis.__piSessionCategoryStateCache = next;
}

export function readSessionCategoryState(): SessionCategoryState {
  return load();
}

export function sessionCategory(sessionId: string): SessionStorageCategory | undefined {
  return sessionCategoryFromState(load(), sessionId);
}

export function setSessionCategory(sessionId: string, category: SessionStorageCategory | null): SessionCategoryState {
  return withStateFileTransaction(SESSION_CATEGORIES_FILE, () => {
  const id = sessionId.trim();
  if (!id) return load();
  const state = load();
  const current = sessionCategory(id);
  if (current === (category ?? undefined)) return state;

  const to_discuss = state.to_discuss.filter((item) => item !== id);
  const to_revise = state.to_revise.filter((item) => item !== id);
  const completed = state.completed.filter((item) => item !== id);

  if (category === "to_discuss") to_discuss.push(id);
  else if (category === "to_revise") to_revise.push(id);
  else if (category === "completed") completed.push(id);

  const next: SessionCategoryState = { to_discuss, to_revise, completed };
  persist(next);
  emitActivityEvent({ kind: "session", sessionId: id });
  return load();
  });
}

export function resetSessionCategoryStateForTests(): void {
  globalThis.__piSessionCategoryStateCache = undefined;
}
