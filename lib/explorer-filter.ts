import { normalizeFilePathSlashes } from "./file-paths.ts";

export const EXPLORER_FILTER_STORAGE_KEY = "pi-web:explorer-filter-v2";
export const LEGACY_EXPLORER_FILTER_STORAGE_KEY = "pi-web:explorer-filter-v1";
export const EXPLORER_FILTER_CHANGED_EVENT = "pi-web:explorer-filter-changed";

/** Common file extensions users may want to hide in the tree. */
export const HIDEABLE_FILE_EXTS = [
  "pdf", "docx", "doc", "pptx", "xlsx",
  "png", "jpg", "jpeg", "gif", "webp", "svg",
  "mp3", "mp4", "wav", "mov",
  "zip", "tar", "gz", "7z",
  "pyc", "pyo", "class", "o", "a",
  "map", "lock", "log", "tmp", "DS_Store",
] as const;

/** Common folder basenames users may want to hide. */
export const HIDEABLE_FOLDER_NAMES = [
  "node_modules", ".git", ".next", ".obsidian", ".obsidian-agent",
  ".stversions", ".stfolder", ".trash", ".cache", ".turbo",
  "dist", "build", "__pycache__", "coverage", "vendor", "target",
  ".venv", "venv", ".pi", ".claude", ".codex", ".cursor",
] as const;

export interface ExplorerFilterSettings {
  /** Hide entries ignored by Git — default false so projects show everything. */
  hideGitIgnored: boolean;
  /** Hide names starting with "." — default true */
  hideDot: boolean;
  /** Exact basename matches (files or folders) */
  customNames: string[];
  /** File extensions without leading dot */
  hideExts: string[];
  /** Folder basenames to hide */
  hideFolders: string[];
  /** Sort key for tree entries (dirs always come first, then by this key) */
  sortBy: "name" | "modified";
  sortOrder: "asc" | "desc";
}

export const DEFAULT_EXPLORER_FILTER: ExplorerFilterSettings = {
  hideGitIgnored: false,
  hideDot: true,
  customNames: [],
  hideExts: [],
  // Sensible defaults for vaults / projects; user can uncheck
  hideFolders: [
    "node_modules", ".git", ".next", ".stversions", ".stfolder",
    ".trash", "__pycache__", "coverage", ".venv", "venv",
  ],
  sortBy: "name",
  sortOrder: "asc",
};

export interface SortableExplorerEntry {
  name: string;
  isDir: boolean;
  /** ISO mtime when available (only fetched when sorting by modified). */
  modified?: string;
}

/** Dirs first, then sortBy + sortOrder inside each group. */
export function compareExplorerEntries(
  a: SortableExplorerEntry,
  b: SortableExplorerEntry,
  sortBy: ExplorerFilterSettings["sortBy"],
  sortOrder: ExplorerFilterSettings["sortOrder"],
): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  let cmp: number;
  if (sortBy === "modified") {
    cmp = (a.modified ?? "").localeCompare(b.modified ?? "");
  } else {
    cmp = a.name.localeCompare(b.name);
  }
  return sortOrder === "desc" ? -cmp : cmp;
}

function uniqueStrings(values: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function normalizeExplorerFilter(input: Partial<ExplorerFilterSettings> | null | undefined): ExplorerFilterSettings {
  return {
    hideGitIgnored: input?.hideGitIgnored === true,
    hideDot: input?.hideDot !== false,
    customNames: uniqueStrings(input?.customNames),
    hideExts: uniqueStrings(input?.hideExts).map((e) => e.replace(/^\./, "").toLowerCase()),
    hideFolders: uniqueStrings(input?.hideFolders),
    sortBy: input?.sortBy === "modified" ? "modified" : "name",
    sortOrder: input?.sortOrder === "desc" ? "desc" : "asc",
  };
}

export function getExplorerFilterProjectKey(projectPath: string): string {
  const normalized = normalizeFilePathSlashes(projectPath.trim());
  if (!normalized) return "/";
  if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized.toLowerCase();
  const key = normalized.replace(/\/+$/, "") || "/";
  return /^[a-zA-Z]:\//.test(key) || key.startsWith("//") ? key.toLowerCase() : key;
}

type StoredExplorerFilters = Record<string, ExplorerFilterSettings>;

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredExplorerFilters(storage: Storage): StoredExplorerFilters {
  try {
    const raw = storage.getItem(EXPLORER_FILTER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { projects?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (!parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects)) return {};

    const projects: StoredExplorerFilters = {};
    for (const [projectPath, filter] of Object.entries(parsed.projects)) {
      if (filter && typeof filter === "object" && !Array.isArray(filter)) {
        projects[projectPath] = normalizeExplorerFilter(filter as Partial<ExplorerFilterSettings>);
      }
    }
    return projects;
  } catch {
    return {};
  }
}

/**
 * One-shot migration source only: the device settings file is the source of
 * truth (see explorer-filter-store.ts + /api/explorer-filter). Returns the
 * browser-stored per-project settings when present, else the legacy global
 * v1 settings, else null. The v1 key is deliberately NOT deleted so every
 * project without its own record can still pick it up (the old code deleted
 * it after the first project, which reset every other project).
 */
export function loadStoredExplorerFilter(projectPath: string): ExplorerFilterSettings | null {
  const storage = getLocalStorage();
  if (!storage) return null;

  try {
    const projects = readStoredExplorerFilters(storage);
    const own = projects[getExplorerFilterProjectKey(projectPath)];
    if (own) return own;

    const legacy = storage.getItem(LEGACY_EXPLORER_FILTER_STORAGE_KEY);
    if (legacy) {
      return normalizeExplorerFilter(JSON.parse(legacy) as Partial<ExplorerFilterSettings>);
    }
  } catch {
    // ignore malformed storage / private mode
  }
  return null;
}


export function parseCustomNamesText(text: string): string[] {
  return uniqueStrings(text.split(/[\n,]/g));
}

export function customNamesToText(names: string[]): string {
  return names.join("\n");
}

function fileExt(name: string): string {
  const base = name.includes("/") ? name.split("/").pop() ?? name : name;
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "";
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

export function shouldHideEntry(
  name: string,
  isDir: boolean,
  settings: ExplorerFilterSettings,
): boolean {
  const s = normalizeExplorerFilter(settings);
  if (s.hideDot && name.startsWith(".")) return true;

  const lower = name.toLowerCase();
  for (const custom of s.customNames) {
    if (lower === custom.toLowerCase()) return true;
  }

  if (isDir) {
    for (const folder of s.hideFolders) {
      if (lower === folder.toLowerCase()) return true;
    }
    return false;
  }

  const ext = fileExt(name);
  if (ext && s.hideExts.includes(ext)) return true;
  return false;
}

/** Query string for /api/files list so server can drop entries early. */
export function explorerFilterToQuery(settings: ExplorerFilterSettings): string {
  const s = normalizeExplorerFilter(settings);
  const params = new URLSearchParams();
  params.set("hideGitIgnored", s.hideGitIgnored ? "1" : "0");
  params.set("hideDot", s.hideDot ? "1" : "0");
  if (s.customNames.length) params.set("hideNames", s.customNames.join(","));
  if (s.hideExts.length) params.set("hideExts", s.hideExts.join(","));
  if (s.hideFolders.length) params.set("hideFolders", s.hideFolders.join(","));
  params.set("sortBy", s.sortBy);
  params.set("sortOrder", s.sortOrder);
  return params.toString();
}

export function explorerFilterFromSearchParams(searchParams: URLSearchParams): ExplorerFilterSettings {
  const hideGitIgnoredRaw = searchParams.get("hideGitIgnored");
  const hideDotRaw = searchParams.get("hideDot");
  return normalizeExplorerFilter({
    hideGitIgnored: hideGitIgnoredRaw === "1",
    hideDot: hideDotRaw === null ? true : hideDotRaw !== "0",
    customNames: (searchParams.get("hideNames") ?? "").split(","),
    hideExts: (searchParams.get("hideExts") ?? "").split(","),
    hideFolders: (searchParams.get("hideFolders") ?? "").split(","),
    sortBy: searchParams.get("sortBy") === "modified" ? "modified" : "name",
    sortOrder: searchParams.get("sortOrder") === "desc" ? "desc" : "asc",
  });
}
