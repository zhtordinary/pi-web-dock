"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type DragEvent } from "react";
import {
  Star,
  Plus,
  Search,
  Trash2,
  Edit2,
  ExternalLink,
  X,
  Check,
  Sparkles,
  MessageSquareQuote,
  Terminal,
  Plug,
  Info,
} from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";
import type { SlashFavoriteCategory } from "@/lib/slash-favorite-state";
import { slashFavoriteCategoryLabel } from "@/lib/slash-display";
import { ReaderFloatingSelect } from "./ReaderFloatingSelect";
import { SlashCommandDetailsSurface } from "./SlashCommandDetailsSurface";
import { encodeFilePathForApi } from "@/lib/file-paths";

export const SLASH_FAVORITES_CHANGED_EVENT = "pi-web:slash-command-favorites-changed";

export interface FavoritesConfigProps {
  onClose?: () => void;
  onOpenFile?: (filePath: string) => void;
  remotePeer?: string;
  embedded?: boolean;
  cwd?: string;
  sessionId?: string;
}

interface CommandMetadata {
  key: string;
  name: string;
  description: string;
  source: "skill" | "customPrompt" | "builtin" | "extension";
  content?: string;
  sourcePath?: string;
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function stripCommandPrefix(name: string): string {
  return name.replace(/^(\/(?:skill:)?|\/)/, "");
}

const BUILTIN_COMMANDS: Array<Omit<CommandMetadata, "description"> & { descriptionKey: string }> = [
  { key: "builtin:compact", name: "/compact", descriptionKey: "chat.commandCompact", source: "builtin" },
  { key: "builtin:auto-compact", name: "/auto-compact", descriptionKey: "chat.commandAutoCompact", source: "builtin" },
  { key: "builtin:reload", name: "/reload", descriptionKey: "chat.commandReload", source: "builtin" },
  { key: "builtin:name", name: "/name", descriptionKey: "chat.commandName", source: "builtin" },
  { key: "builtin:session", name: "/session", descriptionKey: "chat.commandSession", source: "builtin" },
  { key: "builtin:copy", name: "/copy", descriptionKey: "chat.commandCopy", source: "builtin" },
  { key: "builtin:clone", name: "/clone", descriptionKey: "chat.commandClone", source: "builtin" },
];

function builtinCommands(t: (key: string) => string): CommandMetadata[] {
  return BUILTIN_COMMANDS.map(({ descriptionKey, ...command }) => ({ ...command, description: t(descriptionKey) }));
}

export function FavoritesConfig({
  onClose,
  onOpenFile,
  remotePeer,
  embedded = false,
  cwd,
  sessionId,
}: FavoritesConfigProps) {
  const { t } = useI18n();
  const [categories, setCategories] = useState<SlashFavoriteCategory[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem("pi-web:slash-command-favorite-categories:v1");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [filePath, setFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [availableCommands, setAvailableCommands] = useState<CommandMetadata[]>(() => builtinCommands(t));

  // Category modal states
  const [newCategoryModalOpen, setNewCategoryModalOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategory, setEditingCategory] = useState<SlashFavoriteCategory | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [deletingCategory, setDeletingCategory] = useState<SlashFavoriteCategory | null>(null);

  // Command picker modal state
  const [commandPickerOpen, setCommandPickerOpen] = useState(false);
  const [commandPickerSearch, setCommandPickerSearch] = useState("");
  const [commandPickerSource, setCommandPickerSource] = useState<string>("all");
  const [commandPickerTargetCatId, setCommandPickerTargetCatId] = useState<string>("default");

  // Drag and drop state
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [draggingFromCatId, setDraggingFromCatId] = useState<string | null>(null);
  const [dragOverCatId, setDragOverCatId] = useState<string | null>(null);
  const [dragOverCardKey, setDragOverCardKey] = useState<string | null>(null);
  const [hoveredCardKey, setHoveredCardKey] = useState<string | null>(null);
  const [draggingCatId, setDraggingCatId] = useState<string | null>(null);
  const [dragOverCategoryPillId, setDragOverCategoryPillId] = useState<string | null>(null);
  const dragHappenedRef = useRef(false);

  // Command details modal state
  const detailRequestRef = useRef(0);
  const [detailCommand, setDetailCommand] = useState<CommandMetadata | null>(null);
  const [detailContent, setDetailContent] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const newCategoryInputRef = useRef<HTMLInputElement>(null);
  const editCategoryInputRef = useRef<HTMLInputElement>(null);

  const apiPath = useCallback(
    (path: string) => {
      if (!remotePeer) return `/api/${path}`;
      const [pathname, rawQuery] = path.split("?", 2);
      const params = new URLSearchParams(rawQuery);
      params.set("peer", remotePeer);
      const query = params.toString();
      return `/api/remote/${pathname}${query ? `?${query}` : ""}`;
    },
    [remotePeer],
  );

  // Load favorites from API
  const loadFavorites = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(apiPath("slash-command-favorites"), { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (typeof data.filePath === "string") setFilePath(data.filePath);
      if (data.favorites && Array.isArray(data.favorites.categories)) {
        setCategories(data.favorites.categories);
        try {
          window.localStorage.setItem("pi-web:slash-command-favorite-categories:v1", JSON.stringify(data.favorites.categories));
          if (Array.isArray(data.favorites.keys)) {
            window.localStorage.setItem("pi-web:slash-command-favorites:v1", JSON.stringify(data.favorites.keys));
          }
        } catch (error) { void error; }
        if (data.favorites.categories.length > 0 && !data.favorites.categories.some((c: SlashFavoriteCategory) => c.id === commandPickerTargetCatId)) {
          setCommandPickerTargetCatId(data.favorites.categories[0].id);
        }
      }
    } catch (err) {
      console.warn("[FavoritesConfig] failed to load favorites:", err);
    } finally {
      setLoading(false);
    }
  }, [apiPath, commandPickerTargetCatId]);

  // Load available commands (skills, custom prompts, etc.)
  const loadAvailableCommands = useCallback(async () => {
    const list: CommandMetadata[] = builtinCommands(t);
    try {
      // 1. Load custom prompts
      const promptRes = await fetch(apiPath("custom-prompts"), { cache: "no-store" });
      const promptData = await promptRes.json().catch(() => ({}));
      if (Array.isArray(promptData.prompts)) {
        for (const p of promptData.prompts) {
          list.push({
            key: `customPrompt:${p.id}`,
            name: `/${p.title}`,
            description: p.description || p.content?.slice(0, 160) || "",
            content: p.content || "",
            source: "customPrompt",
          });
        }
      }

      // 2. Load skills
      const skillQuery = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const skillRes = await fetch(apiPath(`skills${skillQuery}`), { cache: "no-store" });
      const skillData = await skillRes.json().catch(() => ({}));
      if (Array.isArray(skillData.skills)) {
        for (const s of skillData.skills) {
          const item: CommandMetadata = {
            key: `skill:skill:${s.name}`,
            name: `/skill:${s.name}`,
            description: s.description || "",
            sourcePath: s.filePath,
            source: "skill",
          };
          list.push(item);
          // Also alias `skill:${s.name}` so legacy single-prefix keys match
          list.push({
            ...item,
            key: `skill:${s.name}`,
          });
        }
      }

      // 3. Load extensions and prompts from plugins
      try {
        const pluginRes = await fetch(apiPath(`plugins${skillQuery}`), { cache: "no-store" });
        const pluginData = await pluginRes.json().catch(() => ({}));
        if (Array.isArray(pluginData.packages)) {
          for (const pkg of pluginData.packages) {
            const rawPkgName = pkg.packageName || (typeof pkg.source === "string" ? pkg.source.replace(/^npm:/, "").replace(/@.*$/, "") : "");
            const cleanCmdName = rawPkgName.replace(/^pi-/, "");
            if (Array.isArray(pkg.resources)) {
              for (const r of pkg.resources) {
                if (r.kind === "extension") {
                  list.push({
                    key: `extension:${cleanCmdName}`,
                    name: `/${cleanCmdName}`,
                    description: pkg.description || r.description || t("favorites.extensionCommandDescription", { name: rawPkgName }),
                    sourcePath: r.path,
                    source: "extension",
                  });
                } else if (r.kind === "prompt") {
                  list.push({
                    key: `prompt:${r.name}`,
                    name: `/${r.name}`,
                    description: r.description || "",
                    sourcePath: r.path,
                    source: "customPrompt",
                  });
                }
              }
            }
          }
        }
      } catch (pluginErr) {
        console.warn("[FavoritesConfig] failed to load plugins metadata:", pluginErr);
      }

      // 4. If sessionId is available, initialize cold runtimes before loading
      // commands registered by extensions and prompt templates.
      if (sessionId) {
        try {
          const runtimeRes = await fetch(apiPath(`agent/${sessionId}`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "initialize_runtime" }),
          });
          if (!runtimeRes.ok) throw new Error(`HTTP ${runtimeRes.status}`);
          const cmdRes = await fetch(apiPath(`agent/${sessionId}`), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "get_commands" }),
          });
          if (cmdRes.ok) {
            const cmdData = await cmdRes.json().catch(() => ({}));
            const runtimeCommands = cmdData?.data?.commands || cmdData?.commands;
            if (Array.isArray(runtimeCommands)) {
              for (const cmd of runtimeCommands) {
                if (cmd.source === "extension") {
                  const key = `extension:${cmd.name}`;
                  const existingIdx = list.findIndex((item) => item.key === key);
                  const entry: CommandMetadata = {
                    key,
                    name: `/${cmd.name}`,
                    description: cmd.description || "",
                    sourcePath: cmd.sourceInfo?.path,
                    source: "extension",
                  };
                  if (existingIdx !== -1) list[existingIdx] = entry;
                  else list.push(entry);
                } else if (cmd.source === "prompt") {
                  const key = `prompt:${cmd.name}`;
                  const existingIdx = list.findIndex((item) => item.key === key);
                  const entry: CommandMetadata = {
                    key,
                    name: `/${cmd.name}`,
                    description: cmd.description || "",
                    sourcePath: cmd.sourceInfo?.path,
                    source: "customPrompt",
                  };
                  if (existingIdx !== -1) list[existingIdx] = entry;
                  else list.push(entry);
                }
              }
            }
          }
        } catch (cmdErr) {
          void cmdErr;
        }
      }
    } catch (err) {
      console.warn("[FavoritesConfig] failed to load commands metadata:", err);
    }
    setAvailableCommands(list);
  }, [apiPath, cwd, t]);

  useEffect(() => {
    loadFavorites();
    loadAvailableCommands();
    const handleChanged = () => loadFavorites();
    window.addEventListener(SLASH_FAVORITES_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(SLASH_FAVORITES_CHANGED_EVENT, handleChanged);
  }, [loadFavorites, loadAvailableCommands]);

  // Key to metadata map
  const commandMap = useMemo(() => {
    const map = new Map<string, CommandMetadata>();
    for (const cmd of availableCommands) {
      map.set(cmd.key, cmd);
    }
    return map;
  }, [availableCommands]);

  const getCommandDisplay = useCallback(
    (key: string): CommandMetadata => {
      const existing = commandMap.get(key);
      if (existing) return existing;

      // Skill commands: normalize key (strip redundant "skill:" prefixes)
      if (key.startsWith("skill:")) {
        const cleanSkillName = key.replace(/^(?:skill:)+/, "");
        const matched = commandMap.get(`skill:skill:${cleanSkillName}`) || commandMap.get(`skill:${cleanSkillName}`);
        return {
          key,
          name: `/skill:${cleanSkillName}`,
          description: matched?.description || "",
          sourcePath: matched?.sourcePath,
          content: matched?.content,
          source: "skill",
        };
      }

      // Builtin commands
      if (key.startsWith("builtin:")) {
        const cmdName = key.slice("builtin:".length);
        const builtin = BUILTIN_COMMANDS.find((b) => b.key === key || b.name === `/${cmdName}`);
        return {
          key,
          name: `/${cmdName}`,
          description: builtin ? t(builtin.descriptionKey) : "",
          source: "builtin",
        };
      }

      // Custom Prompts
      if (key.startsWith("customPrompt:")) {
        const promptId = key.slice("customPrompt:".length);
        const prompt = commandMap.get(key);
        if (prompt) return prompt;
        return {
          key,
          name: `/${promptId}`,
          description: "",
          source: "customPrompt",
        };
      }

      // Extensions
      if (key.startsWith("extension:")) {
        const extName = key.slice("extension:".length);
        const matched = commandMap.get(key) || commandMap.get(`extension:${extName}`);
        return {
          key,
          name: `/${extName}`,
          description: matched?.description || "",
          sourcePath: matched?.sourcePath,
          content: matched?.content,
          source: "extension",
        };
      }

      // Prompt templates
      if (key.startsWith("prompt:")) {
        const pName = key.slice("prompt:".length);
        const matched = commandMap.get(key) || commandMap.get(`prompt:${pName}`);
        return {
          key,
          name: `/${pName}`,
          description: matched?.description || "",
          sourcePath: matched?.sourcePath,
          content: matched?.content,
          source: "customPrompt",
        };
      }

      // Fallback parse
      const colonIdx = key.indexOf(":");
      if (colonIdx !== -1) {
        const source = key.slice(0, colonIdx) as CommandMetadata["source"];
        const rawName = key.slice(colonIdx + 1).replace(/^(?:skill:)+/, "");
        return { key, name: `/${rawName}`, description: "", source };
      }
      return { key, name: `/${key}`, description: "", source: "skill" };
    },
    [commandMap, t],
  );

  // Save categories to backend
  const saveCategories = useCallback(
    async (nextCategories: SlashFavoriteCategory[]) => {
      try {
        setSaving(true);
        const res = await fetch(apiPath("slash-command-favorites"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categories: nextCategories }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Failed to save favorites");
        const finalCats = data.favorites && Array.isArray(data.favorites.categories)
          ? data.favorites.categories
          : nextCategories;
        const finalKeys = data.favorites && Array.isArray(data.favorites.keys)
          ? data.favorites.keys
          : nextCategories.flatMap((c) => c.keys);
        setCategories(finalCats);

        try {
          window.localStorage.setItem("pi-web:slash-command-favorites:v1", JSON.stringify(finalKeys));
          window.localStorage.setItem("pi-web:slash-command-favorite-categories:v1", JSON.stringify(finalCats));
        } catch (error) { void error; }

        const eventDetail = data.favorites || { categories: finalCats, keys: finalKeys };
        window.dispatchEvent(
          new CustomEvent(SLASH_FAVORITES_CHANGED_EVENT, { detail: eventDetail }),
        );
        if (typeof window !== "undefined") {
          if (window.parent !== window) {
            window.parent.postMessage({ type: SLASH_FAVORITES_CHANGED_EVENT, detail: eventDetail }, "*");
          }
          document.querySelectorAll("iframe").forEach((frame) => {
            try {
              frame.contentWindow?.postMessage({ type: SLASH_FAVORITES_CHANGED_EVENT, detail: eventDetail }, "*");
            } catch (error) { void error; }
          });
        }
      } catch (err) {
        console.error("[FavoritesConfig] failed to save favorites:", err);
      } finally {
        setSaving(false);
      }
    },
    [apiPath],
  );

  // Category operations
  const handleCreateCategory = async () => {
    const trimmed = newCategoryName.trim();
    if (!trimmed) return;
    const newId = `cat_${Date.now()}`;
    const nextCategories = [...categories, { id: newId, name: trimmed, keys: [] }];
    setNewCategoryName("");
    setNewCategoryModalOpen(false);
    await saveCategories(nextCategories);
    setActiveCategoryId(newId);
  };

  const handleEditCategory = async () => {
    if (!editingCategory) return;
    const trimmed = editingCategoryName.trim();
    if (!trimmed) return;
    if (trimmed === slashFavoriteCategoryLabel(editingCategory, t("favorites.defaultCategory"))) {
      setEditingCategory(null);
      return;
    }
    const nextCategories = categories.map((cat) =>
      cat.id === editingCategory.id ? { ...cat, name: trimmed } : cat,
    );
    setEditingCategory(null);
    await saveCategories(nextCategories);
  };

  const handleDeleteCategory = async () => {
    if (!deletingCategory) return;
    // Move all keys from deleted category into default category (or first remaining category)
    const targetCat = categories.find((c) => c.id !== deletingCategory.id && c.id === "default") ||
      categories.find((c) => c.id !== deletingCategory.id);
    if (!targetCat) return; // Cannot delete the only category

    const keysToMove = deletingCategory.keys.filter((k) => !targetCat.keys.includes(k));
    const nextCategories = categories
      .filter((c) => c.id !== deletingCategory.id)
      .map((c) => (c.id === targetCat.id ? { ...c, keys: [...c.keys, ...keysToMove] } : c));

    setDeletingCategory(null);
    if (activeCategoryId === deletingCategory.id) {
      setActiveCategoryId("all");
    }
    await saveCategories(nextCategories);
  };

  // Helper to match keys considering skill aliases
  const isMatchingKey = (a: string, b: string) => {
    if (a === b) return true;
    if (a.startsWith("skill:") && b.startsWith("skill:")) {
      return a.replace(/^(?:skill:)+/, "") === b.replace(/^(?:skill:)+/, "");
    }
    return false;
  };

  // Command operations
  const handleRemoveKey = async (key: string, fromCatId?: string) => {
    const nextCategories = categories.map((cat) => {
      if (fromCatId && cat.id !== fromCatId) return cat;
      return { ...cat, keys: cat.keys.filter((k) => !isMatchingKey(k, key)) };
    });
    await saveCategories(nextCategories);
  };

  const handleMoveKeyToCategory = async (key: string, fromCatId: string, toCatId: string) => {
    if (fromCatId === toCatId) return;
    const nextCategories = categories.map((cat) => {
      if (cat.id === fromCatId) {
        return { ...cat, keys: cat.keys.filter((k) => !isMatchingKey(k, key)) };
      }
      if (cat.id === toCatId) {
        return { ...cat, keys: cat.keys.some((k) => isMatchingKey(k, key)) ? cat.keys : [...cat.keys, key] };
      }
      return cat;
    });
    await saveCategories(nextCategories);
  };

  const handleAddKeyToCategory = async (key: string, targetCatId: string) => {
    // Remove key from any other category first, then add to target
    const nextCategories = categories.map((cat) => {
      if (cat.id === targetCatId) {
        return { ...cat, keys: cat.keys.some((k) => isMatchingKey(k, key)) ? cat.keys : [...cat.keys, key] };
      }
      return { ...cat, keys: cat.keys.filter((k) => !isMatchingKey(k, key)) };
    });
    await saveCategories(nextCategories);
  };

  const openCommandDetails = useCallback(
    async (meta: CommandMetadata) => {
      const requestId = ++detailRequestRef.current;
      setDetailCommand(meta);
      setDetailContent(meta.content || meta.description || "");
      setDetailError(null);

      const isExtension = meta.source === "extension";
      const sourcePath = !isExtension ? meta.sourcePath : undefined;
      if (!sourcePath || isExtension) {
        setDetailLoading(false);
        return;
      }

      setDetailLoading(true);
      try {
        let offset = 0;
        let content = "";
        let truncated = false;
        do {
          const response = await fetch(
            apiPath(`files/${encodeFilePathForApi(sourcePath)}?type=read&offset=${offset}`),
          );
          if (!response.ok) throw new Error(`details read failed: ${response.status}`);
          const data = (await response.json()) as { content?: unknown; nextOffset?: unknown; truncated?: unknown };
          const chunk = typeof data.content === "string" ? data.content : "";
          const nextOffset = typeof data.nextOffset === "number" ? data.nextOffset : offset;
          content += chunk;
          truncated = data.truncated === true;
          if (!truncated || nextOffset <= offset) break;
          offset = nextOffset;
        } while (content.length < 4 * 1024 * 1024);

        if (requestId !== detailRequestRef.current) return;
        setDetailContent(content || meta.content || meta.description || "");
        setDetailError(truncated ? t("chat.slashCommandDetailsTooLarge") : null);
      } catch (error) {
        if (requestId !== detailRequestRef.current) return;
        setDetailContent(meta.content || meta.description || "");
        if (!meta.content && !meta.description) {
          setDetailError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (requestId === detailRequestRef.current) setDetailLoading(false);
      }
    },
    [remotePeer, t],
  );

  // Drag and drop handlers
  const handleDragStart = (e: DragEvent, key: string, catId: string) => {
    dragHappenedRef.current = true;
    setDraggingKey(key);
    setDraggingFromCatId(catId);
    e.dataTransfer.setData("text/plain", JSON.stringify({ key, fromCatId: catId }));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOverCard = (e: DragEvent, targetKey: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragOverCardKey !== targetKey) {
      setDragOverCardKey(targetKey);
    }
  };

  const handleDropOnCard = async (e: DragEvent, targetKey: string, targetCatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverCardKey(null);
    setDragOverCatId(null);
    if (!draggingKey || !draggingFromCatId) return;

    if (draggingKey === targetKey) {
      setDraggingKey(null);
      setDraggingFromCatId(null);
      return;
    }

    const nextCategories = categories.map((cat) => {
      // Remove from source
      const keys = cat.keys.filter((k) => k !== draggingKey);
      if (cat.id === targetCatId) {
        // Insert before or after targetKey
        const targetIdx = keys.indexOf(targetKey);
        if (targetIdx !== -1) {
          keys.splice(targetIdx, 0, draggingKey);
        } else {
          keys.push(draggingKey);
        }
      }
      return { ...cat, keys };
    });

    setDraggingKey(null);
    setDraggingFromCatId(null);
    setTimeout(() => {
      dragHappenedRef.current = false;
    }, 120);
    await saveCategories(nextCategories);
  };

  const handleDropOnCategoryHeader = async (e: DragEvent, toCatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverCatId(null);
    if (!draggingKey || !draggingFromCatId) return;
    if (draggingFromCatId === toCatId) {
      setDraggingKey(null);
      setDraggingFromCatId(null);
      setTimeout(() => {
        dragHappenedRef.current = false;
      }, 120);
      return;
    }

    await handleMoveKeyToCategory(draggingKey, draggingFromCatId, toCatId);
    setDraggingKey(null);
    setDraggingFromCatId(null);
    setTimeout(() => {
      dragHappenedRef.current = false;
    }, 120);
  };

  const handleCategoryDragStart = (e: DragEvent, catId: string) => {
    dragHappenedRef.current = true;
    setDraggingCatId(catId);
    e.dataTransfer.setData("application/x-pi-category", catId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleCategoryDragOver = (e: DragEvent, targetCatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggingCatId) {
      if (dragOverCategoryPillId !== targetCatId) {
        setDragOverCategoryPillId(targetCatId);
      }
    } else if (draggingKey) {
      if (dragOverCatId !== targetCatId) {
        setDragOverCatId(targetCatId);
      }
    }
  };

  const handleCategoryDrop = async (e: DragEvent, targetCatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceCatId = draggingCatId;
    setDraggingCatId(null);
    setDragOverCategoryPillId(null);

    // If dragging a category tab to reorder
    if (sourceCatId) {
      if (sourceCatId === targetCatId) {
        dragHappenedRef.current = false;
        return;
      }
      const sourceIdx = categories.findIndex((c) => c.id === sourceCatId);
      const targetIdx = categories.findIndex((c) => c.id === targetCatId);
      if (sourceIdx === -1 || targetIdx === -1) {
        dragHappenedRef.current = false;
        return;
      }
      const next = [...categories];
      const [removed] = next.splice(sourceIdx, 1);
      next.splice(targetIdx, 0, removed);
      setTimeout(() => {
        dragHappenedRef.current = false;
      }, 120);
      await saveCategories(next);
      return;
    }

    // If dragging a command card into this category
    if (draggingKey && draggingFromCatId) {
      await handleDropOnCategoryHeader(e, targetCatId);
    }
  };

  // Filtered categories to display
  const displayCategories = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return categories
      .filter((cat) => activeCategoryId === "all" || cat.id === activeCategoryId)
      .map((cat) => {
        const matchingKeys = cat.keys.filter((key) => {
          if (!q) return true;
          const meta = getCommandDisplay(key);
          return meta.name.toLowerCase().includes(q) || meta.description.toLowerCase().includes(q);
        });
        return { ...cat, keys: matchingKeys, totalCount: cat.keys.length };
      });
  }, [categories, activeCategoryId, searchQuery, getCommandDisplay]);

  // Command picker filtered items
  const pickerItems = useMemo(() => {
    const q = commandPickerSearch.trim().toLowerCase();
    const allFavoritedKeyMap = new Map<string, string>(); // key -> category name
    for (const cat of categories) {
      const label = slashFavoriteCategoryLabel(cat, t("favorites.defaultCategory"));
      for (const k of cat.keys) {
        allFavoritedKeyMap.set(k, label);
        if (k.startsWith("skill:")) {
          const clean = k.replace(/^(?:skill:)+/, "");
          allFavoritedKeyMap.set(`skill:skill:${clean}`, label);
          allFavoritedKeyMap.set(`skill:${clean}`, label);
        }
      }
    }

    const seenNames = new Set<string>();
    return availableCommands.filter((cmd) => {
      if (commandPickerSource !== "all" && cmd.source !== commandPickerSource) return false;
      if (seenNames.has(cmd.name)) return false;
      seenNames.add(cmd.name);
      if (!q) return true;
      return cmd.name.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q);
    }).map((cmd) => ({
      ...cmd,
      favoritedCategory: allFavoritedKeyMap.get(cmd.key)
        || (cmd.source === "skill"
          ? allFavoritedKeyMap.get(`skill:skill:${cmd.name.replace(/^\/skill:/, "")}`) || allFavoritedKeyMap.get(`skill:${cmd.name.replace(/^\/skill:/, "")}`)
          : null)
        || null,
    }));
  }, [availableCommands, commandPickerSearch, commandPickerSource, categories, t]);

  const totalFavoritesCount = useMemo(() => {
    return categories.reduce((sum, c) => sum + c.keys.length, 0);
  }, [categories]);

  const sourceIcon = (source: string) => {
    switch (source) {
      case "skill": return <Sparkles size={13} style={{ color: "#8b5cf6" }} />;
      case "customPrompt": return <MessageSquareQuote size={13} style={{ color: "#3b82f6" }} />;
      case "builtin": return <Terminal size={13} style={{ color: "#10b981" }} />;
      case "extension": return <Plug size={13} style={{ color: "#f59e0b" }} />;
      default: return <Sparkles size={13} />;
    }
  };

  const sourceLabel = (source: string) => {
    switch (source) {
      case "skill": return t("chat.skills");
      case "customPrompt": return t("chat.customPrompts");
      case "builtin": return t("chat.builtin");
      case "extension": return t("chat.extension");
      default: return source;
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg)",
        color: "var(--text)",
        position: "relative",
      }}
    >
      {/* Top Bar: Title, Path, Action Buttons, Search */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 0,
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, padding: "0 18px", minHeight: 47, boxSizing: "border-box", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: "1 1 auto" }}>
            <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>{t("settings.favorites")}</span>
            {filePath && (
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono, monospace)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
                title={filePath}
              >
                {shortenPath(filePath)}
              </span>
            )}
            {filePath && onOpenFile && (
              <button
                type="button"
                onClick={() => onOpenFile(filePath)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--accent, #3b82f6)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                title={t("settings.openInReaderTitle")}
                aria-label={t("settings.openInReaderTitle")}
              >
                <ExternalLink size={13} strokeWidth={2} />
              </button>
            )}
          </div>

        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: "0 18px", minHeight: 47, flexWrap: "wrap" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: 170,
              height: 30,
              boxSizing: "border-box",
              padding: "0 8px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              flexShrink: 0,
            }}
          >
            <Search size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
            <input
              type="text"
              placeholder={t("favorites.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--text)",
                fontSize: 12,
                width: "100%",
                minWidth: 0,
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: "var(--text-muted)" }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          <ConfigButton
            variant="primary"
            type="button"
            onClick={() => setCommandPickerOpen(true)}
          >
            <Plus size={13} />
            <span>{t("favorites.addFromAll")}</span>
          </ConfigButton>

          <ConfigButton
            variant="primary"
            type="button"
            onClick={() => {
              setNewCategoryName("");
              setNewCategoryModalOpen(true);
              setTimeout(() => newCategoryInputRef.current?.focus(), 50);
            }}
          >
            <Plus size={13} />
            <span>{t("favorites.newCategory")}</span>
          </ConfigButton>

          {/* Legend */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 12,
              fontSize: 11,
              color: "var(--text-dim)",
              flexShrink: 0,
              padding: "0 4px",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t("chat.skills")}>
              <Sparkles size={12} style={{ color: "#8b5cf6" }} />
              <span>{t("chat.skills")}</span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t("chat.extensions")}>
              <Plug size={12} style={{ color: "#f59e0b" }} />
              <span>{t("chat.extensions")}</span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t("chat.customPrompts")}>
              <MessageSquareQuote size={12} style={{ color: "#3b82f6" }} />
              <span>{t("chat.customPrompts")}</span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={t("chat.builtIn")}>
              <Terminal size={12} style={{ color: "#10b981" }} />
              <span>{t("chat.builtIn")}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Subcategory Pills Navigation */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 18px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          overflowX: "auto",
          scrollbarWidth: "none",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setActiveCategoryId("all")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 32,
            boxSizing: "border-box",
            padding: "0 10px",
            borderRadius: 14,
            border: activeCategoryId === "all" ? "1px solid var(--accent)" : "1px solid var(--border)",
            background: activeCategoryId === "all" ? "var(--bg-selected, rgba(59, 130, 246, 0.12))" : "var(--bg-panel)",
            color: activeCategoryId === "all" ? "var(--accent)" : "var(--text-muted)",
            fontSize: 12,
            fontWeight: activeCategoryId === "all" ? 600 : 500,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <span>{t("favorites.all")}</span>
          <span style={{ fontSize: 11, opacity: 0.8 }}>({totalFavoritesCount})</span>
        </button>

        {categories.map((cat) => {
          const isSelected = activeCategoryId === cat.id;
          const isDragOverAsTarget = dragOverCatId === cat.id;
          const isDragOverCategoryPill = dragOverCategoryPillId === cat.id;
          const isDraggingSelf = draggingCatId === cat.id;
          return (
            <div
              key={cat.id}
              className="favorites-category-pill"
              draggable
              onDragStart={(e) => handleCategoryDragStart(e, cat.id)}
              onDragOver={(e) => handleCategoryDragOver(e, cat.id)}
              onDragLeave={() => {
                if (dragOverCategoryPillId === cat.id) setDragOverCategoryPillId(null);
                if (dragOverCatId === cat.id) setDragOverCatId(null);
              }}
              onDrop={(e) => handleCategoryDrop(e, cat.id)}
              onDragEnd={() => {
                setDraggingCatId(null);
                setDragOverCategoryPillId(null);
                setDragOverCatId(null);
                setTimeout(() => { dragHappenedRef.current = false; }, 120);
              }}
              onClick={() => {
                if (!dragHappenedRef.current) {
                  setActiveCategoryId(cat.id);
                }
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                height: 32,
                boxSizing: "border-box",
                padding: "0 10px",
                borderRadius: 14,
                position: "relative",
                border: isDragOverCategoryPill
                  ? "2px solid var(--accent)"
                  : isDragOverAsTarget
                  ? "2px dashed var(--accent)"
                  : isSelected
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border)",
                background: isSelected
                  ? "var(--bg-selected, rgba(59, 130, 246, 0.12))"
                  : isDragOverCategoryPill || isDragOverAsTarget
                  ? "var(--bg-selected, rgba(59, 130, 246, 0.08))"
                  : "var(--bg-panel)",
                color: isSelected ? "var(--accent)" : "var(--text-muted)",
                fontSize: 12,
                cursor: "grab",
                flexShrink: 0,
                opacity: isDraggingSelf ? 0.45 : 1,
                transform: isDragOverCategoryPill ? "scale(1.04)" : "none",
                transition: "all 0.15s ease",
                userSelect: "none",
              }}
              title={t("favorites.categoryDragHint")}
            >
              <span
                style={{ fontWeight: isSelected ? 600 : 500 }}
              >
                {slashFavoriteCategoryLabel(cat, t("favorites.defaultCategory"))} ({cat.keys.length})
              </span>
              <div className="favorites-category-actions">
                <button
                  type="button"
                  className="favorites-category-action"
                  draggable={false}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingCategory(cat);
                    setEditingCategoryName(slashFavoriteCategoryLabel(cat, t("favorites.defaultCategory")));
                    setTimeout(() => editCategoryInputRef.current?.focus(), 50);
                  }}
                  title={t("i18n.rename")}
                  aria-label={t("i18n.rename")}
                >
                  <Edit2 size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
                {categories.length > 1 && (
                  <button
                    type="button"
                    className="favorites-category-action is-danger"
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingCategory(cat);
                    }}
                    title={t("i18n.delete")}
                    aria-label={t("i18n.delete")}
                  >
                    <Trash2 size={13} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Main Content Area: Cards by Category */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {loading ? (
          <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            {t("i18n.loading")}
          </div>
        ) : displayCategories.length === 0 || displayCategories.every((c) => c.keys.length === 0) ? (
          <div
            style={{
              padding: "60px 20px",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}
          >
            <Star size={36} style={{ color: "var(--text-muted)", opacity: 0.4 }} />
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {searchQuery
                ? t("favorites.noMatch")
                : t("favorites.emptyState")}
            </div>
            {!searchQuery && (
              <ConfigButton
                type="button"
                onClick={() => setCommandPickerOpen(true)}
              >
                <Plus size={14} />
                <span>{t("favorites.addFromAll")}</span>
              </ConfigButton>
            )}
          </div>
        ) : (
          displayCategories.map((cat) => {
            if (cat.keys.length === 0 && searchQuery) return null;
            return (
              <div
                key={cat.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragOverCatId !== cat.id) setDragOverCatId(cat.id);
                }}
                onDragLeave={() => {
                  if (dragOverCatId === cat.id) setDragOverCatId(null);
                }}
                onDrop={(e) => handleDropOnCategoryHeader(e, cat.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  padding: "12px",
                  borderRadius: 8,
                  border: dragOverCatId === cat.id ? "2px dashed var(--accent)" : "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  transition: "border 0.15s ease",
                }}
              >
                {/* Section Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{slashFavoriteCategoryLabel(cat, t("favorites.defaultCategory"))}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>({cat.totalCount})</span>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {t("favorites.dragHint")}
                  </span>
                </div>

                {/* Cards Grid */}
                {cat.keys.length === 0 ? (
                  <div
                    style={{
                      padding: "20px 0",
                      textAlign: "center",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      border: "1px dashed var(--border)",
                      borderRadius: 6,
                    }}
                  >
                    {t("favorites.emptyCategory")}
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                      gap: 8,
                    }}
                  >
                    {cat.keys.map((key) => {
                      const meta = getCommandDisplay(key);
                      const isDragging = draggingKey === key;
                      const isDragOverThis = dragOverCardKey === key;
                      const isHovered = hoveredCardKey === key;
                      return (
                        <div
                          key={key}
                          draggable
                          onMouseEnter={() => setHoveredCardKey(key)}
                          onMouseLeave={() => setHoveredCardKey((cur) => (cur === key ? null : cur))}
                          onDragStart={(e) => handleDragStart(e, key, cat.id)}
                          onDragEnd={() => {
                            setTimeout(() => {
                              dragHappenedRef.current = false;
                            }, 120);
                          }}
                          onDragOver={(e) => handleDragOverCard(e, key)}
                          onDrop={(e) => handleDropOnCard(e, key, cat.id)}
                          onClick={() => {
                            if (dragHappenedRef.current) {
                              dragHappenedRef.current = false;
                              return;
                            }
                            void openCommandDetails(meta);
                          }}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "flex-start",
                            alignItems: "stretch",
                            gap: 5,
                            minHeight: 64,
                            padding: "9px 11px",
                            borderRadius: 7,
                            border: isDragOverThis
                              ? "2px solid var(--accent)"
                              : isHovered
                                ? "1px solid var(--accent, #3b82f6)"
                                : "1px solid var(--border)",
                            background: isHovered ? "var(--bg-panel)" : "var(--bg)",
                            opacity: isDragging ? 0.4 : 1,
                            cursor: "grab",
                            transition: "border-color 0.12s ease, box-shadow 0.12s ease, background-color 0.12s ease",
                            boxShadow: isHovered ? "0 2px 8px rgba(0,0,0,0.06)" : "none",
                          }}
                        >
                          {/* Card Top: Icon, Name, Info, Remove */}
                          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                flexShrink: 0,
                              }}
                              title={sourceLabel(meta.source)}
                            >
                              {sourceIcon(meta.source)}
                            </div>
                            <div
                              style={{
                                flex: 1,
                                minWidth: 0,
                                fontSize: 12,
                                fontWeight: 600,
                                fontFamily: "var(--font-mono, monospace)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                color: isHovered ? "var(--accent, #3b82f6)" : "var(--text)",
                                transition: "color 0.12s ease",
                              }}
                              title={meta.name}
                            >
                              {stripCommandPrefix(meta.name)}
                            </div>
                            <div
                              style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {categories.length > 1 && (
                                <ReaderFloatingSelect
                                  value={cat.id}
                                  onChange={(val) => void handleMoveKeyToCategory(key, cat.id, val)}
                                  options={categories.map((c) => ({ value: c.id, label: slashFavoriteCategoryLabel(c, t("favorites.defaultCategory")) }))}
                                  ariaLabel={t("favorites.moveTo")}
                                  title={t("favorites.moveTo")}
                                  placement="below"
                                  align="end"
                                  triggerStyle={{
                                    fontSize: 11,
                                    padding: "1px 6px",
                                    height: 20,
                                  }}
                                />
                              )}
                              <ConfigButton variant="ghost" size="small" className="config-button-icon"
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void openCommandDetails(meta);
                                }}
                                title={t("chat.viewSlashCommandDetails")}
                                aria-label={t("chat.viewSlashCommandDetails")}
                              >
                                <Info size={13} />
                              </ConfigButton>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveKey(key, cat.id);
                                }}
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  color: "var(--text-muted)",
                                  padding: 2,
                                  cursor: "pointer",
                                  borderRadius: 3,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  opacity: isHovered ? 0.9 : 0.6,
                                  transition: "opacity 0.12s ease",
                                }}
                                title={t("favorites.remove")}
                                aria-label={t("favorites.remove")}
                              >
                                <X size={13} />
                              </button>
                            </div>
                          </div>

                          {/* Content / Description Preview */}
                          {meta.description && (
                            <div
                              style={{
                                display: "-webkit-box",
                                WebkitBoxOrient: "vertical",
                                WebkitLineClamp: 2,
                                overflow: "hidden",
                                fontSize: 11,
                                lineHeight: 1.35,
                                color: "var(--text-muted)",
                                paddingLeft: 0,
                                marginTop: 2,
                              }}
                              title={meta.description}
                            >
                              {meta.description}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* New Category Modal */}
      {newCategoryModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setNewCategoryModalOpen(false);
          }}
        >
          <div
            style={{
              width: 320,
              padding: "16px 18px",
              borderRadius: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{t("favorites.newCategory")}</span>
            <input
              ref={newCategoryInputRef}
              type="text"
              placeholder={t("favorites.categoryNamePlaceholder")}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateCategory();
                if (e.key === "Escape") setNewCategoryModalOpen(false);
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <ConfigButton
                type="button"
                onClick={() => setNewCategoryModalOpen(false)}
              >
                {t("i18n.cancel")}
              </ConfigButton>
              <ConfigButton variant="primary"
                type="button"
                onClick={handleCreateCategory}
                disabled={!newCategoryName.trim() || saving}
              >
                {t("files.createConfirm")}
              </ConfigButton>
            </div>
          </div>
        </div>
      )}

      {/* Edit Category Modal */}
      {editingCategory && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingCategory(null);
          }}
        >
          <div
            style={{
              width: 320,
              padding: "16px 18px",
              borderRadius: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{t("favorites.renameCategory")}</span>
            <input
              ref={editCategoryInputRef}
              type="text"
              value={editingCategoryName}
              onChange={(e) => setEditingCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEditCategory();
                if (e.key === "Escape") setEditingCategory(null);
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <ConfigButton
                type="button"
                onClick={() => setEditingCategory(null)}
              >
                {t("i18n.cancel")}
              </ConfigButton>
              <ConfigButton variant="primary"
                type="button"
                onClick={handleEditCategory}
                disabled={!editingCategoryName.trim() || saving}
              >
                {t("i18n.save")}
              </ConfigButton>
            </div>
          </div>
        </div>
      )}

      {/* Delete Category Confirm Modal */}
      {deletingCategory && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeletingCategory(null);
          }}
        >
          <div
            style={{
              width: 340,
              padding: "16px 18px",
              borderRadius: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{t("favorites.deleteCategoryTitle")}</span>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("favorites.deleteCategoryConfirm")}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <ConfigButton
                type="button"
                onClick={() => setDeletingCategory(null)}
              >
                {t("i18n.cancel")}
              </ConfigButton>
              <ConfigButton variant="danger"
                type="button"
                onClick={handleDeleteCategory}
                disabled={saving}
              >
                {t("i18n.delete")}
              </ConfigButton>
            </div>
          </div>
        </div>
      )}

      {/* Command Picker Modal (从全量命令添加收藏) */}
      {commandPickerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCommandPickerOpen(false);
          }}
        >
          <div
            style={{
              width: 580,
              maxWidth: "calc(100vw - 32px)",
              height: 520,
              maxHeight: "calc(100vh - 48px)",
              borderRadius: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              boxShadow: "0 10px 32px rgba(0,0,0,0.3)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 18px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg-panel)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Star size={16} style={{ color: "var(--accent)" }} />
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {t("favorites.addFromAll")}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setCommandPickerOpen(false)}
                style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Filter & Target Category Bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 18px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg)",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              {/* Search */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  flex: 1,
                  minWidth: 160,
                }}
              >
                <Search size={13} style={{ color: "var(--text-muted)" }} />
                <input
                  type="text"
                  placeholder={t("favorites.searchCommandPlaceholder")}
                  value={commandPickerSearch}
                  onChange={(e) => setCommandPickerSearch(e.target.value)}
                  style={{
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    color: "var(--text)",
                    fontSize: 12,
                    width: "100%",
                  }}
                />
              </div>

              {/* Source Type Filter */}
              <ReaderFloatingSelect
                value={commandPickerSource}
                onChange={(val) => setCommandPickerSource(val)}
                options={[
                  { value: "all", label: t("favorites.allSources") },
                  { value: "skill", label: t("chat.skills") },
                  { value: "customPrompt", label: t("chat.customPrompts") },
                  { value: "builtin", label: t("chat.builtin") },
                ]}
                ariaLabel={t("favorites.allSources")}
                placement="below"
                triggerStyle={{
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              />

              {/* Target Category Selector */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <span style={{ color: "var(--text-muted)" }}>{t("favorites.addToCategory")}</span>
                <ReaderFloatingSelect
                  value={commandPickerTargetCatId}
                  onChange={(val) => setCommandPickerTargetCatId(val)}
                  options={categories.map((c) => ({ value: c.id, label: slashFavoriteCategoryLabel(c, t("favorites.defaultCategory")) }))}
                  ariaLabel={t("favorites.addToCategory")}
                  placement="below"
                  triggerStyle={{
                    fontSize: 12,
                    padding: "4px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                />
              </div>
            </div>

            {/* Commands List */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: "8px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {pickerItems.length === 0 ? (
                <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
                  {t("favorites.noMatchingCommands")}
                </div>
              ) : (
                pickerItems.map((item) => {
                  const isFavorited = item.favoritedCategory !== null;
                  return (
                    <div
                      key={item.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 12px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: isFavorited ? "var(--bg-panel)" : "var(--bg)",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                        {sourceIcon(item.source)}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace" }}>{item.name}</span>
                            <span
                              style={{
                                fontSize: 10,
                                color: "var(--text-muted)",
                                background: "var(--bg-panel)",
                                padding: "1px 4px",
                                borderRadius: 3,
                              }}
                            >
                              {sourceLabel(item.source)}
                            </span>
                          </div>
                          {item.description && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "var(--text-muted)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                marginTop: 2,
                              }}
                            >
                              {item.description}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Right Action */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <ConfigButton variant="ghost" size="small" className="config-button-icon"
                          type="button"
                          onClick={() => void openCommandDetails(item)}
                          title={t("chat.viewSlashCommandDetails")}
                          aria-label={t("chat.viewSlashCommandDetails")}
                        >
                          <Info size={12} />
                        </ConfigButton>
                        {isFavorited ? (
                          <>
                            <span style={{ fontSize: 11, color: "var(--accent)" }}>
                              {t("favorites.alreadyIn", { category: item.favoritedCategory ?? "" })}
                            </span>
                            <ConfigButton size="small"
                              type="button"
                              onClick={() => handleRemoveKey(item.key)}
                            >
                              {t("favorites.remove")}
                            </ConfigButton>
                          </>
                        ) : (
                          <ConfigButton variant="primary" size="small"
                            type="button"
                            onClick={() => handleAddKeyToCategory(item.key, commandPickerTargetCatId)}
                          >
                            <Plus size={11} />
                            <span>{t("favorites.addAction")}</span>
                          </ConfigButton>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Command Details Modal */}
      {detailCommand && (
        <SlashCommandDetailsSurface
          label={detailCommand.name}
          content={detailContent}
          loading={detailLoading}
          error={detailError}
          sourcePath={detailCommand.source !== "extension" ? detailCommand.sourcePath : undefined}
          cwd={cwd}
          remotePeer={remotePeer}
          onClose={() => setDetailCommand(null)}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}
