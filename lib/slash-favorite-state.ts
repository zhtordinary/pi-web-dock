import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { DEFAULT_SLASH_FAVORITE_CATEGORY_ID, DEFAULT_SLASH_FAVORITE_CATEGORY_NAME } from "./slash-display.ts";

export interface SlashFavoriteCategory {
  id: string;
  name: string;
  keys: string[];
}

export interface SlashFavoriteState {
  schemaVersion?: number;
  categories: SlashFavoriteCategory[];
  keys: string[];
}

export const SLASH_FAVORITES_FILE = process.env.PI_WEB_SLASH_FAVORITES_FILE
  ?? join(process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? ".", ".config"), "pi-web-reader", "slash-command-favorites.json");

export const DEFAULT_CATEGORY_ID = DEFAULT_SLASH_FAVORITE_CATEGORY_ID;
export const DEFAULT_CATEGORY_NAME = DEFAULT_SLASH_FAVORITE_CATEGORY_NAME;

const EMPTY: SlashFavoriteState = {
  schemaVersion: 2,
  categories: [{ id: DEFAULT_CATEGORY_ID, name: DEFAULT_CATEGORY_NAME, keys: [] }],
  keys: [],
};

export function normalizeSlashFavoriteKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const item of value) {
    const key = typeof item === "string" ? item.trim() : "";
    if (!key || keys.includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

export function normalizeSlashFavoriteCategories(value: unknown, fallbackKeys: string[] = []): SlashFavoriteCategory[] {
  if (!Array.isArray(value)) {
    return [{ id: DEFAULT_CATEGORY_ID, name: DEFAULT_CATEGORY_NAME, keys: fallbackKeys }];
  }
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const categories: SlashFavoriteCategory[] = [];

  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Partial<SlashFavoriteCategory>;
    let id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || seenIds.has(id)) {
      id = id ? `${id}_${i}` : `cat_${i + 1}`;
    }
    seenIds.add(id);

    const name = typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : (id === DEFAULT_CATEGORY_ID ? DEFAULT_CATEGORY_NAME : `分类 ${i + 1}`);

    const rawKeys = Array.isArray(raw.keys) ? raw.keys : [];
    const keys: string[] = [];
    for (const k of rawKeys) {
      const key = typeof k === "string" ? k.trim() : "";
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      keys.push(key);
    }
    categories.push({ id, name, keys });
  }

  // If fallbackKeys has any keys not seen in any category, add them to the first category (or create default)
  const remaining = fallbackKeys.filter((k) => !seenKeys.has(k));
  if (categories.length === 0) {
    categories.push({ id: DEFAULT_CATEGORY_ID, name: DEFAULT_CATEGORY_NAME, keys: remaining });
  } else if (remaining.length > 0) {
    categories[0].keys.push(...remaining);
  }

  return categories;
}

function normalize(value: unknown): SlashFavoriteState {
  if (Array.isArray(value)) {
    const keys = normalizeSlashFavoriteKeys(value);
    return {
      schemaVersion: 2,
      categories: [{ id: DEFAULT_CATEGORY_ID, name: DEFAULT_CATEGORY_NAME, keys }],
      keys,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid slash favorites file format");
  }
  const obj = value as { keys?: unknown; categories?: unknown; schemaVersion?: unknown };
  if (!Array.isArray(obj.keys) && !Array.isArray(obj.categories)) {
    throw new Error("Invalid slash favorites file format");
  }

  const rawKeys = Array.isArray(obj.keys) ? normalizeSlashFavoriteKeys(obj.keys) : [];
  const categories = normalizeSlashFavoriteCategories(obj.categories, rawKeys);
  const allKeys: string[] = [];
  const keySet = new Set<string>();
  for (const cat of categories) {
    for (const key of cat.keys) {
      if (!keySet.has(key)) {
        keySet.add(key);
        allKeys.push(key);
      }
    }
  }

  return {
    schemaVersion: 2,
    categories,
    keys: allKeys,
  };
}

export function readSlashFavoriteState(): SlashFavoriteState {
  if (!existsSync(SLASH_FAVORITES_FILE)) {
    return {
      schemaVersion: 2,
      categories: [{ id: DEFAULT_CATEGORY_ID, name: DEFAULT_CATEGORY_NAME, keys: [] }],
      keys: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(SLASH_FAVORITES_FILE, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to read slash favorites state: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalize(parsed);
}

function persistCategories(categories: SlashFavoriteCategory[]): SlashFavoriteState {
  const allKeys: string[] = [];
  const keySet = new Set<string>();
  for (const cat of categories) {
    for (const key of cat.keys) {
      if (!keySet.has(key)) {
        keySet.add(key);
        allKeys.push(key);
      }
    }
  }

  const state: SlashFavoriteState = {
    schemaVersion: 2,
    categories,
    keys: allKeys,
  };

  mkdirSync(dirname(SLASH_FAVORITES_FILE), { recursive: true });
  writePrivateFileAtomicSync(
    SLASH_FAVORITES_FILE,
    `${JSON.stringify({ schemaVersion: 2, categories }, null, 2)}\n`,
  );
  return state;
}

export function setSlashFavoriteKeys(value: unknown): SlashFavoriteState {
  const current = existsSync(SLASH_FAVORITES_FILE)
    ? (() => { try { return readSlashFavoriteState(); } catch { return null; } })()
    : null;

  const targetKeys = normalizeSlashFavoriteKeys(value);
  const targetSet = new Set(targetKeys);

  let categories: SlashFavoriteCategory[];
  if (current && current.categories.length > 0) {
    // Preserve existing category structure: filter removed keys, keep existing assignments
    const existingKeySet = new Set<string>();
    categories = current.categories.map((cat) => {
      const kept = cat.keys.filter((k) => targetSet.has(k));
      for (const k of kept) existingKeySet.add(k);
      return { ...cat, keys: kept };
    });
    // Add any completely new keys to the first category
    const addedKeys = targetKeys.filter((k) => !existingKeySet.has(k));
    if (addedKeys.length > 0) {
      if (categories.length === 0) {
        categories.push({ id: DEFAULT_CATEGORY_ID, name: DEFAULT_CATEGORY_NAME, keys: addedKeys });
      } else {
        categories[0].keys.push(...addedKeys);
      }
    }
  } else {
    categories = [{ id: DEFAULT_CATEGORY_ID, name: DEFAULT_CATEGORY_NAME, keys: targetKeys }];
  }

  return persistCategories(categories);
}

export function setSlashFavoriteCategories(value: unknown): SlashFavoriteState {
  const categories = normalizeSlashFavoriteCategories(value);
  return persistCategories(categories);
}
