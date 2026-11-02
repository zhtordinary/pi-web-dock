import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { slashFavoriteCategoryLabel } from "../lib/slash-display.ts";
import { testTranslator } from "./test-locale.mjs";

test("saving an unchanged translated default category does not rename stored data", async () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components", "FavoritesConfig.tsx"), "utf8");
  const start = source.indexOf("  const handleEditCategory = async () => {");
  const end = source.indexOf("\n  };", start);
  assert.ok(start >= 0 && end > start);
  const category = { id: "default", name: "常用", keys: [] };
  let saved, closed = false;
  const context = {
    editingCategory: category, editingCategoryName: "Favorites", categories: [category],
    slashFavoriteCategoryLabel, t: testTranslator("en"),
    setEditingCategory: (value) => { closed = value === null; },
    saveCategories: async (value) => { saved = value; },
  };
  const edit = vm.runInNewContext(`${source.slice(start, end + 5)}\nhandleEditCategory`, context);
  await edit();
  assert.equal(closed, true);
  assert.equal(saved, undefined);
  context.editingCategoryName = "Review";
  await edit();
  assert.equal(saved[0].name, "Review");
});

test("builtin fallback descriptions use the current language", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components", "FavoritesConfig.tsx"), "utf8");
  const start = source.indexOf("  const getCommandDisplay = useCallback(");
  const end = source.indexOf("\n  // Save categories to backend", start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpile(`${source.slice(start, end)}\ngetCommandDisplay;`);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const t = testTranslator(locale);
    let dependencies;
    const display = vm.runInNewContext(code, {
      commandMap: new Map(), t,
      BUILTIN_COMMANDS: [{ key: "builtin:compact", name: "/compact", descriptionKey: "chat.commandCompact", source: "builtin" }],
      useCallback: (fn, deps) => { dependencies = deps; return fn; },
    });
    assert.equal(display("builtin:compact").description, t("chat.commandCompact"));
    assert.equal(display("builtin:unknown").description, "");
    assert.ok(dependencies.includes(t));
  }
});

test("FavoritesConfig defines canonical controls and subcategory management", () => {
  const filePath = path.join(process.cwd(), "components", "FavoritesConfig.tsx");
  const source = fs.readFileSync(filePath, "utf8");

  // Header & path controls
  assert.ok(source.includes("onOpenFile"), "supports onOpenFile prop");
  assert.ok(source.includes("embedded"), "supports embedded prop");
  assert.ok(source.includes("shortenPath"), "shortens path for display");
  assert.ok(source.includes("ExternalLink"), "renders external link for opening favorites file");

  // Category CRUD
  assert.ok(source.includes("newCategoryModalOpen"), "supports new category creation dialog");
  assert.ok(source.includes("editingCategory"), "supports category rename");
  assert.ok(source.includes("deletingCategory"), "supports category deletion with item migration");

  // Subcategory pills & drag-and-drop
  assert.ok(source.includes("handleDropOnCategoryHeader"), "supports dropping commands onto category headers/pills");
  assert.ok(source.includes("handleDragStart"), "supports drag start on favorite cards");
  assert.ok(source.includes("handleDropOnCard"), "supports reordering via drop on cards");

  // Command picker modal
  assert.ok(source.includes("commandPickerOpen"), "supports command picker modal");
  assert.ok(source.includes("commandPickerSource"), "supports filtering command picker by source");
  assert.ok(source.includes("commandPickerTargetCatId"), "supports choosing target category in picker");

  // Event synchronization
  assert.ok(source.includes("SLASH_FAVORITES_CHANGED_EVENT"), "exports and listens to favorite changed event");
});

test("FavoritesConfig supports moving commands via drag and drop to category tabs without redundant button", () => {
  const filePath = path.join(process.cwd(), "components", "FavoritesConfig.tsx");
  const source = fs.readFileSync(filePath, "utf8");

  assert.ok(source.includes("handleMoveKeyToCategory"), "provides handleMoveKeyToCategory");
  assert.ok(source.includes("handleDropOnCategoryHeader"), "category pills accept drop to move commands across groups");
  assert.ok(!source.includes("GripVertical"), "cards omit redundant drag handle icon to save space");
});

test("FavoritesConfig header and cards follow unified design invariants", () => {
  const filePath = path.join(process.cwd(), "components", "FavoritesConfig.tsx");
  const source = fs.readFileSync(filePath, "utf8");
  const settingsCss = fs.readFileSync(path.join(process.cwd(), "app", "settings.css"), "utf8");

  assert.match(source, /variant="primary"[\s\S]*favorites\.addFromAll/);
  assert.match(source, /variant="primary"[\s\S]*favorites\.newCategory/);
  assert.doesNotMatch(source, /t\("common\.(cancel|create|delete|loading|rename|save)"\)/);
  assert.match(source, /height: 32,[\s\S]*padding: "0 10px"/);
  assert.match(source, /className="favorites-category-actions"/);
  assert.match(source, /className="favorites-category-action is-danger"/);
  assert.match(settingsCss, /\.favorites-category-actions[\s\S]*opacity: 0[\s\S]*pointer-events: none/);
  assert.match(settingsCss, /\.favorites-category-pill:hover \.favorites-category-actions[\s\S]*opacity: 1[\s\S]*pointer-events: auto/);
  assert.match(settingsCss, /\.favorites-category-action[\s\S]*border: 0[\s\S]*border-radius: 0[\s\S]*background: transparent/);

  // The divider spans the panel; only the title and controls keep horizontal padding.
  const topBar = source.slice(source.indexOf("{/* Top Bar:"), source.indexOf("{/* Subcategory Pills Navigation */}"));
  const outerStyle = topBar.slice(0, topBar.indexOf("      >"));
  assert.doesNotMatch(outerStyle, /padding:/);
  assert.equal((topBar.match(/padding: "0 18px"/g) ?? []).length, 2);
  assert.match(topBar, /padding: "0 18px", minHeight: 47, boxSizing: "border-box", borderBottom: "1px solid var\(--border\)"/);

  // Open file button uses unified icon-only pattern matching other settings panels
  assert.ok(source.includes("settings.openInReaderTitle"), "uses standard openInReaderTitle translation for open button");
  assert.ok(!source.includes("common.openFile"), "does not hardcode raw common.openFile on open button");

  // Path is not artificially capped at 240px
  assert.ok(!source.includes("maxWidth: 240"), "path is not arbitrarily capped at 240px");

  // Skills normalize to single /skill: prefix and strip duplicate skill:
  assert.ok(source.includes('replace(/^(?:skill:)+/, "")'), "normalizes skill keys and strips duplicate skill prefixes");
  assert.ok(!source.includes('name = source === "skill" ? `/skill:${rawName}` : `/${rawName}`'), "does not produce double /skill:skill:");

  // Cards do not have heavy bottom row with redundant badge
  assert.ok(!source.includes("borderTop: \"1px solid var(--border)\""), "cards do not have heavy bottom row divider");
});

test("category actions mask their label with the pill background without changing layout", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "app", "settings.css"), "utf8");
  const actions = css.match(/\.favorites-category-actions\s*\{([^}]+)\}/)?.[1];
  assert.ok(actions);
  assert.match(actions, /position: absolute/);
  assert.match(actions, /background: inherit/);
  assert.match(actions, /height: calc\(100% - 4px\)/);
  assert.match(actions, /padding: 0 2px/);
  assert.doesNotMatch(actions, /transition:/);
  assert.match(css, /\.favorites-category-pill:hover \.favorites-category-actions,\s*\.favorites-category-pill:focus-within \.favorites-category-actions\s*\{\s*opacity: 1;\s*pointer-events: auto;/);
});

test("FavoritesConfig cards show rich content preview and open SlashCommandDetailsSurface on click", () => {
  const filePath = path.join(process.cwd(), "components", "FavoritesConfig.tsx");
  const source = fs.readFileSync(filePath, "utf8");

  // Content preview with 2-line clamp matching slash command palette
  assert.ok(source.includes("WebkitLineClamp: 2"), "cards display up to 2 lines of description preview");

  // Click card or info button to view details
  assert.ok(source.includes("openCommandDetails"), "provides openCommandDetails callback");
  assert.ok(source.includes("SlashCommandDetailsSurface"), "integrates SlashCommandDetailsSurface modal");
  assert.ok(source.includes("chat.viewSlashCommandDetails"), "cards provide detail view button with accessible title");
});
