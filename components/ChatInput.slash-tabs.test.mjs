import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SLASH_TABS } = await jiti.import("./ChatInput.tsx");

test("slash tabs place custom prompts first, followed by favorites, skills, plugin prompts, extensions, builtin, and all", async () => {
  assert.deepEqual([...SLASH_TABS], [
    "customPrompt", "favorites", "skill", "prompt", "extension", "builtin", "all",
  ]);

  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(source, /customPrompt: "chat\.customPrompts"/);
  assert.match(source, /prompt: "chat\.prompts"/);
});

test("i18n dictionaries name customPrompt as '提示词' and plugin prompt as '插件提示词'", async () => {
  const zhCn = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
  const en = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
  const zhTw = await readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8");

  // zh-CN
  assert.match(zhCn, /"chat\.customPrompts": "提示词"/);
  assert.match(zhCn, /"chat\.prompts": "插件提示词"/);

  // en
  assert.match(en, /"chat\.customPrompts": "Prompts"/);
  assert.match(en, /"chat\.prompts": "Plugin Prompts"/);

  // zh-TW
  assert.match(zhTw, /"chat\.customPrompts": "提示詞"/);
  assert.match(zhTw, /"chat\.prompts": "插件提示詞"/);
});

test("favorites and custom prompts eliminate loading delay with local storage and instant revalidation", async () => {
  const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const promptsConfigSource = await readFile(new URL("./PromptsConfig.tsx", import.meta.url), "utf8");
  const favoritesConfigSource = await readFile(new URL("./FavoritesConfig.tsx", import.meta.url), "utf8");
  const customPromptsRoute = await readFile(new URL("../app/api/custom-prompts/route.ts", import.meta.url), "utf8");

  // ChatInput local storage instant reads
  assert.match(chatInputSource, /readLocalSlashFavoriteCategories/);
  assert.match(chatInputSource, /readLocalCustomPrompts/);
  assert.match(chatInputSource, /SLASH_FAVORITE_CATEGORIES_STORAGE_KEY/);
  assert.match(chatInputSource, /CUSTOM_PROMPTS_STORAGE_KEY/);

  // ChatInput revalidation on open
  assert.match(chatInputSource, /void loadCustomPrompts\(\);[\s\S]*?void loadSlashFavorites\(\);/);

  // ChatInput background revalidation preserves existing items without wiping to []
  assert.doesNotMatch(
    chatInputSource,
    /const loadCustomPrompts = useCallback\(async \(\) => \{\s*const requestId = \+\+customPromptRequestIdRef\.current;\s*setCustomPrompts\(\[\]\);/,
    "loadCustomPrompts must not wipe customPrompts to empty array while revalidating",
  );

  // Custom prompts API route has no-store cache control
  assert.match(customPromptsRoute, /const noStore = \{ "Cache-Control": "no-store" \};/);
  assert.match(customPromptsRoute, /headers: noStore/);

  // PromptsConfig broadcasts and caches
  assert.match(promptsConfigSource, /broadcastPromptsChanged/);
  assert.match(promptsConfigSource, /pi-web:custom-prompts:v1/);

  // FavoritesConfig caches categories and keys in localStorage
  assert.match(favoritesConfigSource, /pi-web:slash-command-favorite-categories:v1/);
  assert.match(favoritesConfigSource, /pi-web:slash-command-favorites:v1/);
});
