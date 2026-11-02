// Device-local server-side store for explorer filter (ignore-rule) settings.
// Per-project entries keyed like the browser storage, but persisted to a
// settings file on each device instead of localStorage, so Reader releases
// never touch it and rules never ride along with the browser.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import {
  getExplorerFilterProjectKey,
  normalizeExplorerFilter,
  type ExplorerFilterSettings,
} from "./explorer-filter";

const STORE_FILE = "explorer-filter.json";

/** ~/.config/pi-web-reader/explorer-filter.json (XDG_CONFIG_HOME aware). */
export function getExplorerFilterStorePath(): string {
  const override = process.env.EXPLORER_FILTER_STORE?.trim();
  if (override) return resolve(override);
  const configRoot = process.env.XDG_CONFIG_HOME?.trim()
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(configRoot, "pi-web-reader", STORE_FILE);
}

type StoredExplorerFilters = Record<string, ExplorerFilterSettings>;

function readAll(): StoredExplorerFilters {
  try {
    const raw = readFileSync(getExplorerFilterStorePath(), "utf8");
    const parsed = JSON.parse(raw) as { projects?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const projects: StoredExplorerFilters = {};
    for (const [key, value] of Object.entries(parsed.projects ?? {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        projects[key] = normalizeExplorerFilter(value as Partial<ExplorerFilterSettings>);
      }
    }
    return projects;
  } catch {
    return {};
  }
}

function writeAll(projects: StoredExplorerFilters): void {
  const path = getExplorerFilterStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: 1, projects }, null, 2));
  renameSync(tmp, path);
}

/** Settings for one project, or null when the file has no record for it. */
export function loadExplorerFilterForProject(projectPath: string): ExplorerFilterSettings | null {
  const projects = readAll();
  return projects[getExplorerFilterProjectKey(projectPath)] ?? null;
}

export function saveExplorerFilterForProject(projectPath: string, settings: ExplorerFilterSettings): void {
  const projects = readAll();
  projects[getExplorerFilterProjectKey(projectPath)] = normalizeExplorerFilter(settings);
  writeAll(projects);
}
