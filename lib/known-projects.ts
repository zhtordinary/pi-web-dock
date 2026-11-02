import { withStateFileTransaction } from "./state-file-transaction.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";

/**
 * Projects the user has actively opened by path (custom path picker). They
 * stay in the project list even while they have zero sessions, so the user
 * does not have to re-locate the directory after the last session is gone.
 * Per-device state — each machine keeps the paths typed on that machine.
 */

export interface KnownProject {
  path: string;
  addedAt: string;
}

const PROJECTS_FILE = process.env.PI_WEB_PROJECTS_FILE
  ?? join(process.env.XDG_DATA_HOME || join(process.env.HOME ?? ".", ".local", "share"), "pi-web-reader", "projects.json");

interface RuntimeState {
  loaded: boolean;
  projects: KnownProject[];
}

declare global {
  var __piKnownProjectsRuntime: RuntimeState | undefined;
}

function runtime(): RuntimeState {
  if (!globalThis.__piKnownProjectsRuntime) {
    globalThis.__piKnownProjectsRuntime = { loaded: false, projects: [] };
  }
  return globalThis.__piKnownProjectsRuntime;
}

function validProject(value: unknown): value is KnownProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<KnownProject>;
  return typeof project.path === "string" && project.path.length > 0 && typeof project.addedAt === "string";
}

function load(strict = false): RuntimeState {
  const state = runtime();
  state.projects = [];
  state.loaded = true;
  try {
    if (!existsSync(PROJECTS_FILE)) return state;
    const parsed = JSON.parse(readFileSync(PROJECTS_FILE, "utf8")) as { projects?: unknown };
    if (Array.isArray(parsed.projects)) state.projects = parsed.projects.filter(validProject);
  } catch (error) {
    if (strict) throw error;
    // Read-only UI remains usable; mutations must not overwrite corrupt state.
    state.projects = [];
  }
  return state;
}

function persist(): void {
  mkdirSync(dirname(PROJECTS_FILE), { recursive: true });
  writePrivateFileAtomicSync(PROJECTS_FILE, JSON.stringify({ projects: runtime().projects }, null, 2));
}

export function listKnownProjects(): KnownProject[] {
  return load().projects;
}

/** Record a path the user actively opened. Returns the updated list. */
export function addKnownProject(path: string): KnownProject[] {
  return withStateFileTransaction(PROJECTS_FILE, () => {
  const state = load(true);
  const existing = state.projects.find((project) => project.path === path);
  if (existing) {
    existing.addedAt = new Date().toISOString();
  } else {
    state.projects.push({ path, addedAt: new Date().toISOString() });
  }
  persist();
  return state.projects;
  });
}

/** Forget a saved path. Sessions (if any) keep the project listed. */
export function removeKnownProject(path: string): KnownProject[] {
  return withStateFileTransaction(PROJECTS_FILE, () => {
  const state = load(true);
  state.projects = state.projects.filter((project) => project.path !== path);
  persist();
  return state.projects;
  });
}
