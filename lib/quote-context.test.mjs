import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSelectionToolbarTop,
  getQuotePreviewMaxHeight,
  formatQuoteItemsToMarkdown,
  isQuoteShortcut,
  DEFAULT_QUOTE_SHORTCUT,
  QUOTE_SHORTCUT_STORAGE_KEY,
  loadStoredQuoteShortcut,
  setStoredQuoteShortcut,
} from "./quote-context.ts";
import { testTranslator } from "../components/test-locale.mjs";

const en = testTranslator("en");
const zhCN = testTranslator("zh-CN");

test("keeps the selection toolbar below the visible chat area", () => {
  assert.equal(clampSelectionToolbarTop(-12, 72, 800), 80);
  assert.equal(clampSelectionToolbarTop(120, 72, 800), 128);
  assert.equal(clampSelectionToolbarTop(900, 72, 800), 750);
});

test("limits upward quote previews to the visible area", () => {
  assert.equal(getQuotePreviewMaxHeight(760, 72), 674);
  assert.equal(getQuotePreviewMaxHeight(60, 72), 0);
  assert.equal(getQuotePreviewMaxHeight(760, -20, 8), 752);
});

test("formatQuoteItemsToMarkdown formats numbered quotes with standard blockquotes", () => {
  const empty = formatQuoteItemsToMarkdown([], en);
  assert.equal(empty, "");

  const intro = en("chat.quoteIntro");
  const single = formatQuoteItemsToMarkdown([
    { id: "q1", text: "line 1\nline 2" },
  ], en);
  assert.equal(single, `[1] ${intro}\n\n> line 1\n> line 2`);

  const multiple = formatQuoteItemsToMarkdown([
    { id: "q1", text: "first quote" },
    { id: "q2", text: "second quote\nline 2" },
  ], en);
  assert.equal(
    multiple,
    `[1] ${intro}\n\n> first quote\n\n[2] ${intro}\n\n> second quote\n> line 2`,
  );

  const withReply = formatQuoteItemsToMarkdown([
    { id: "q1", text: "quoted passage", reply: "  my comment  " },
  ], en);
  assert.equal(
    withReply,
    `[1] ${intro}\n\n> quoted passage\n\n${en("chat.quoteReplyLine", { reply: "my comment" })}`,
  );

  // The preamble follows the UI language; Simplified Chinese keeps its original wording.
  assert.equal(
    formatQuoteItemsToMarkdown([{ id: "q1", text: "quoted passage", reply: "my comment" }], zhCN),
    `[1] ${zhCN("chat.quoteIntro")}\n\n> quoted passage\n\n${zhCN("chat.quoteReplyLine", { reply: "my comment" })}`,
  );
});

test("isQuoteShortcut handles Mod+e and avoids Cmd+Shift+R", () => {
  const macCmdE = {
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    key: "e",
  };
  assert.equal(isQuoteShortcut(macCmdE, "Mod+e"), true);
  assert.equal(isQuoteShortcut(macCmdE, "Cmd+e"), true);

  // Shift key pressed should NOT match Mod+e
  const macCmdShiftE = { ...macCmdE, shiftKey: true };
  assert.equal(isQuoteShortcut(macCmdShiftE, "Mod+e"), false);

  // Cmd+Shift+R should NOT match Mod+e
  const cmdShiftR = {
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    key: "r",
  };
  assert.equal(isQuoteShortcut(cmdShiftR, "Mod+e"), false);
  assert.equal(isQuoteShortcut(cmdShiftR, "Cmd+e"), false);
});
