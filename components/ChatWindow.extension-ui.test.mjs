import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const enMessages = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhCNMessages = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
const extensionDialog = source.slice(source.indexOf("function ExtensionDialog"), source.indexOf("function ExtensionCustomPanel"));
const customPanel = source.slice(source.indexOf("function ExtensionCustomPanel"));

test("standard extension input keeps IME confirmation Enter out of submit", () => {
  assert.match(extensionDialog, /handleExtensionDialogInputKeyDown\(\s*e\.nativeEvent,/);
  assert.match(extensionDialog, /getExtensionDialogInputCompositionEndAtOnBlur/);
  assert.match(extensionDialog, /inputCompositionActiveRef/);
  assert.match(extensionDialog, /inputCompositionEndAtRef/);
  assert.match(extensionDialog, /onCompositionStart=\{\(\) => \{/);
  assert.match(extensionDialog, /onCompositionEnd=\{\(\) => \{/);
});

test("extension select dialog uses a unified adaptive scrollable body and Reader stepper controls", () => {
  assert.match(
    source,
    /width: "min\(560px, 100%\)",\s*maxHeight: "min\(680px, 100%\)",\s*display: "flex",\s*flexDirection: "column"/,
  );
  assert.doesNotMatch(source, /height: isSelect \? "min\(760px, 100%\)"/);
  assert.match(source, /chat\.extensionNavigation/);
  assert.match(source, /onClick=\{\(\) => moveSelection\(-1\)\}/);
  assert.match(source, /onClick=\{\(\) => moveSelection\(1\)\}/);
  assert.match(source, /className="extension-dialog-body"[\s\S]*?flex: "1 1 auto",\s*minHeight: 0,\s*overflowY: "auto"/);
  assert.match(source, /fontSize: 12\.5,\s*lineHeight: 1\.5,\s*overflowWrap: "anywhere",/);
});

test("custom extension panel exposes touch controls for TUI choices and submit", () => {
  assert.match(customPanel, /className="extension-custom-control"/);
  assert.match(customPanel, /t\("chat.extensionMoveUp"\)/);
  assert.match(customPanel, /t\("chat.extensionMoveDown"\)/);
  assert.match(customPanel, /onClick=\{\(\) => pressTerminalKey\("ArrowUp"\)\}/);
  assert.match(customPanel, /onClick=\{\(\) => pressTerminalKey\("ArrowDown"\)\}/);
  assert.match(customPanel, /onClick=\{editorSnapshot \? submitEditor : \(\) => pressTerminalKey\("Enter"\)\}/);
  assert.match(cssSource, /\.extension-custom-control[\s\S]*?touch-action: manipulation/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.extension-custom-control[\s\S]*?min-width: 44px/);
});

test("custom extension panel uses a visible native text editor", () => {
  assert.match(customPanel, /className="extension-custom-editor"/);
  assert.match(customPanel, /value=\{editorText\}/);
  assert.match(customPanel, /onChange=\{handleEditorChange\}/);
  assert.match(customPanel, /getTextEdit\(previousText, nextText\)/);
  assert.match(customPanel, /event\.key === "Enter" && !event\.shiftKey/);
  assert.match(customPanel, /setSelectionRange/);
  assert.match(customPanel, /asBracketedPaste\(edit\.inserted\)/);
  assert.doesNotMatch(customPanel, /pointerEvents: "none"/);
  assert.match(cssSource, /\.extension-custom-editor[\s\S]*?caret-color/);
});

test("custom extension panel provides terminal input fallback and handles Enter when editorSnapshot is null", () => {
  assert.match(customPanel, /className="extension-custom-terminal-input"/);
  assert.match(customPanel, /terminalInputRef/);
  assert.match(customPanel, /toTerminalKeyData\(event\)/);
  assert.match(customPanel, /sendInput\(data\)/);
  assert.match(customPanel, /"Enter"/);
});

test("custom extension panel does not steal focus after read-only text selection", () => {
  assert.match(customPanel, /if \(range && preRef\.current\?\.contains\(range\.commonAncestorContainer\)\) return;/);
  assert.match(customPanel, /if \(selection && !selection\.isCollapsed && preRef\.current\?\.contains\(selection\.anchorNode\)\) return;/);
  assert.match(customPanel, /selectedTextRef\.current = getSelectedPanelText\(\);[\s\S]*?if \(!range \|\| !preRef\.current\?\.contains\(range\.commonAncestorContainer\)\) restoreInputFocus\(\);/);
});

test("custom extension panel focuses native editor when editor view appears", () => {
  assert.match(customPanel, /\}, \[request\.id, hasEditorSnapshot\]\);/);
});

test("custom extension panel separates Escape navigation from host Close", () => {
  assert.match(
    customPanel,
    /<button[\s\S]{0,180}onClick=\{\(\) => pressTerminalKey\("Escape"\)\}[\s\S]{0,180}title=\{t\("chat\.extensionEscape"\)\}[\s\S]{0,180}aria-label=\{t\("chat\.extensionEscape"\)\}[\s\S]{0,180}>\s*Esc\s*<\/button>/,
  );
  assert.match(customPanel, /onClick=\{\(\) => onClose\(request\)\}[\s\S]{0,1000}t\("chat\.close"\)/);
  assert.match(customPanel, /sendInput\("\\x03"\)/);
  assert.match(enMessages, /"chat\.extensionEscape": "Send Escape"/);
  assert.match(zhCNMessages, /"chat\.extensionEscape": "发送 Esc 键"/);
});
