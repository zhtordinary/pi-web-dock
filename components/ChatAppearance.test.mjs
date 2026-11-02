import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInput = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const generalConfig = await readFile(new URL("./GeneralConfig.tsx", import.meta.url), "utf8");
const settingsPanel = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const chatAppearanceHook = await readFile(new URL("../hooks/useChatAppearance.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { clampChatContentWidth } = await jiti.import("../hooks/useChatAppearance.ts");

const widthVariable = /var\(--chat-content-max-width, 90%\)/g;

test("chat content keeps the shared 90% default behind one variable", () => {
  assert.equal((chatWindow.match(widthVariable) ?? []).length, 2);
  assert.equal((chatInput.match(widthVariable) ?? []).length, 1);
  assert.match(globals, /--chat-content-max-width: 90%;/);
  assert.match(chatWindow, /className="chat-content relative flex h-full/);
  assert.doesNotMatch(chatWindow, /max-w-\[820px\]|maxWidth: 820/);
  assert.doesNotMatch(chatInput, /maxWidth: 820/);
});

test("General chat settings share live appearance state", () => {
  assert.match(generalConfig, /useChatAppearance\(\)/);
  assert.doesNotMatch(generalConfig, /CHAT_WIDTH_STORAGE_KEY|CHAT_FONT_SIZE_STORAGE_KEY|applyChatSizingStyles|CHAT_SIZING_CHANGED_EVENT/);
  assert.match(generalConfig, /\{chatWidth\}%/);
  assert.match(generalConfig, /step=\{5\}/);
  assert.match(chatWindow, /useChatAppearance\(\)/);
  assert.match(chatInput, /useChatAppearance\(\)/);
  assert.match(settingsPanel, /useChatAppearance\(\)/);
  assert.match(settingsPanel, /min=\{CHAT_CONTENT_WIDTH_MIN\}/);
  assert.match(settingsPanel, /max=\{CHAT_CONTENT_WIDTH_MAX\}/);
  assert.match(settingsPanel, /step=\{5\}/);
  assert.ok(
    settingsPanel.indexOf('t("settings.quoteSelection")') < settingsPanel.indexOf('t("settings.chatContentWidth")'),
    "selection toggle stays before width slider in the shared settings panel",
  );
  assert.match(chatAppearanceHook, /--chat-content-max-width", `\$\{width\}%`/);
  assert.match(chatAppearanceHook, /localStorage\.setItem/);
});

test("chat width validation uses percentages and resets legacy pixel values", () => {
  assert.equal(clampChatContentWidth(undefined), 90);
  assert.equal(clampChatContentWidth(null), 90);
  assert.equal(clampChatContentWidth(""), 90);
  assert.equal(clampChatContentWidth("invalid"), 90);
  assert.equal(clampChatContentWidth(40), 50);
  assert.equal(clampChatContentWidth(80), 80);
  assert.equal(clampChatContentWidth(99.4), 99);
  assert.equal(clampChatContentWidth(100), 100);
  assert.equal(clampChatContentWidth(1240), 90);
});

test("chat settings offer width only and ignore stored font-size overrides", () => {
  for (const source of [generalConfig, settingsPanel]) {
    assert.match(source, /settings\.chatContentWidth/);
    assert.doesNotMatch(source, /chatContentFontSize|CHAT_CONTENT_FONT_SIZE|setFontSize/);
  }
  assert.match(chatAppearanceHook, /readStoredPreference\(CHAT_CONTENT_WIDTH_STORAGE_KEY\)/);
  assert.doesNotMatch(chatAppearanceHook, /fontSize|FONT_SIZE|chat-content-font-size/);
  assert.match(globals, /--chat-content-font-size: 14px;/);
});

test("new-session composer does not apply the percentage column twice", () => {
  assert.match(chatInput, /maxWidth: constrainWidth \? "var\(--chat-content-max-width, 90%\)" : "100%"/);
  assert.match(chatWindow, /constrainWidth=\{!isEmptyNew\}/);
});
