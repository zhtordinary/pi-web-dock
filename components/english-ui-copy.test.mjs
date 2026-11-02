import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { CJK_TEXT, testTranslator } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, { fsCache: false, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { formatSideBranchTitle } = await jiti.import("./BranchNavigator.tsx");
const { SidekickAnswer, SidekickHeader, SidekickQuestion, restoreSidekickDraft } = await jiti.import("./SidekickDrawer.tsx");
const { WorktreeSessionBuckets } = await jiti.import("./WorktreeSessionBuckets.tsx");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { QuoteCardGroup } = await jiti.import("./QuoteCardGroup.tsx");
const { SearchReplaceBar } = await jiti.import("./SearchReplaceBar.tsx");
const { MarkdownTocPanel } = await jiti.import("./MarkdownToc.tsx");
const { GeneralConfig } = await jiti.import("./GeneralConfig.tsx");
const { compactImageQuoteSummary } = await jiti.import("./image-generation-quote-display.ts");
const { formatQuoteItemsToMarkdown } = await jiti.import("../lib/quote-context.ts");
const { slashFavoriteCategoryLabel, DEFAULT_SLASH_FAVORITE_CATEGORY_ID, DEFAULT_SLASH_FAVORITE_CATEGORY_NAME } = await jiti.import("../lib/slash-display.ts");
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");
const en = testTranslator("en");

/** Renders under the English catalog, the copy a pi-locale=en page sees on first paint. */
function renderEnglish(component, props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "en" }, React.createElement(component, props)));
}

/** The language picker names each language in its own script. */
const languageNames = getSupportedLocales().map((id) => getLocalePlugin(id).label);

function assertEnglish(html, label, allowed = []) {
  const visible = allowed.reduce((text, name) => text.split(name).join(""), html);
  const index = visible.search(CJK_TEXT);
  assert.equal(index, -1, `${label} shows Chinese: ${visible.slice(Math.max(0, index - 80), index + 80)}`);
}

test("message actions and terminology results render English copy", () => {
  const actions = { onEditContent() {}, onStartSideBranch() {}, onNavigate() {}, onFork() {} };
  assertEnglish(renderEnglish(MessageView, { message: { role: "user", content: "First question" }, entryId: "user-1", isFirstUserMessage: true, ...actions }), "first user message");
  assertEnglish(renderEnglish(MessageView, { message: { role: "user", content: "Follow-up question" }, entryId: "user-2", prevAssistantEntryId: "assistant-1", ...actions }), "later user message");
  assertEnglish(renderEnglish(MessageView, { message: { role: "user", content: "Forking now" }, entryId: "user-3", prevAssistantEntryId: "assistant-1", forking: true, ...actions }), "forking user message");
  assertEnglish(renderEnglish(MessageView, {
    message: { role: "assistant", content: [{ type: "text", text: "An answer" }], provider: "test", model: "test-model" },
    entryId: "assistant-1", onStartSideBranch() {}, onFork() {},
  }), "assistant message");
  assertEnglish(renderEnglish(MessageView, {
    message: { role: "user", content: "How should I describe this cache issue?" },
    sessionId: "session-1",
    entryId: "user-4",
    questionAnalysisJob: {
      jobId: "job-1", targetEntryId: "user-4", status: "completed", mode: "context", requestedAt: 1,
      result: {
        text: "- **Cache stampede**: many requests rebuild one entry at once",
        usage: { input: 120, output: 30, cacheRead: 10, cacheWrite: 0, totalTokens: 160 },
        pricing: { configured: false },
        context: { mode: "context", source: "existing-summary" },
      },
    },
  }), "terminology result");
});

test("stored automatic branch titles follow the current locale without changing their content", () => {
  const zh = testTranslator("zh-TW");
  assert.equal(formatSideBranchTitle("分支: First question", en), "Branch: First question");
  assert.equal(formatSideBranchTitle("临时：First question", en), "Branch: First question");
  assert.equal(formatSideBranchTitle("分支 3", en), "Branch 3");
  assert.equal(formatSideBranchTitle("Branch: 用户内容", zh), "分支: 用户内容");
  assert.equal(formatSideBranchTitle("Branch 3", zh), "分支 3");
  assert.equal(formatSideBranchTitle("A custom title", en), "A custom title");
});

test("Side Ask questions, answers, topic tabs and restore notes render English copy", () => {
  assertEnglish(renderEnglish(SidekickQuestion, { question: "Side question", images: [{ data: "AQID", mimeType: "image/png" }], copied: false, onCopy() {}, onQuote() {} }), "side question");
  assertEnglish(renderEnglish(SidekickQuestion, { question: "Side question", images: [], copied: true, onCopy() {} }), "copied side question");
  for (const entry of [
    { stopReason: "length", data: { answer: "", thinking: "Kept thinking" } },
    { stopReason: "stop", data: { answer: "", thinking: "" } },
  ]) assertEnglish(renderEnglish(SidekickAnswer, { entry }), "side answer");
  assertEnglish(renderEnglish(SidekickHeader, {
    threads: [{ id: "default", label: "1", count: 3 }, { id: "other", label: "2", count: 0 }],
    activeThreadId: "default", busyThreads: new Set(["other"]), mainBusy: true, expanded: false, rightPanel: false,
    canFork: true, isForking: false, onSelect() {}, onCloseThread() {}, onDelete() {}, onCreate() {}, onFork() {}, onExpand() {}, onClose() {},
  }), "side ask header");
  const previous = { drafts: { view: { question: "typed", images: [], error: null } }, replies: { view: { runId: "run", question: "asked", images: [], answer: "", thinking: "", running: false } } };
  const source = { runId: "run", question: "asked", images: [] };
  assert.doesNotMatch(restoreSidekickDraft(previous, "view", source, false, en).drafts.view.error, CJK_TEXT);
  assert.doesNotMatch(restoreSidekickDraft(previous, "view", source, false, en, "refused").replies.view.answer, CJK_TEXT);
});

test("worktree buckets and the composer's continue controls render English copy", () => {
  const sessions = [
    { id: "main", cwd: "/repo", projectRoot: "/repo", isGit: true, branch: "main" },
    { id: "linked", cwd: "/repo/.worktrees/feature", projectRoot: "/repo", isGit: true, isWorktree: true, branch: "feature" },
  ];
  assertEnglish(renderEnglish(WorktreeSessionBuckets, {
    items: sessions, sessionOf: (item) => item, mainLabel: en("sessionActivity.worktreeMain"), worktreeLabel: en("sessionActivity.worktreeLinked"),
    showProjectPath: true, onNewSession() {}, renderItems: (rows) => rows.map((row) => React.createElement("span", { key: row.id }, row.id)),
  }), "worktree buckets");
  const composer = { onSend() {}, onAbort() {}, isStreaming: false, onContinue() {}, onUnattendedChange() {}, onStopContinue() {} };
  for (const continueUi of [
    { kind: "stopped", reason: "fatal", errorText: "invalid api key" },
    { kind: "stopped", reason: "limit", errorText: null },
    { kind: "running", nextDelayMs: 4_000, errorText: "overloaded" },
  ]) {
    for (const unattended of [true, false]) assertEnglish(renderEnglish(ChatInput, { ...composer, continueUi, unattended }), `composer ${continueUi.kind}`);
  }
});

test("quotes, find and replace, document contents and settings render English copy", () => {
  assertEnglish(renderEnglish(QuoteCardGroup, {
    quotes: [{ id: "q1", text: "Selected text", reply: "My comment" }, { id: "q2", text: "Another passage" }],
    onRemoveQuote() {}, onJumpToQuote() {}, onEditQuote() {},
  }), "quote cards");
  for (const onTextChange of [undefined, () => {}]) {
    assertEnglish(renderEnglish(SearchReplaceBar, { isOpen: true, initialShowReplace: true, onClose() {}, text: "alpha beta", onTextChange }), "find and replace");
  }
  assertEnglish(renderEnglish(MarkdownTocPanel, { source: "# Title\n\n## Part one\n\n### Detail\n\n## Part two\n", scrollRootRef: { current: null } }), "document contents");
  assertEnglish(renderEnglish(GeneralConfig, {}), "general settings", languageNames);
});

test("text built outside React follows the English catalog", () => {
  const quote = formatQuoteItemsToMarkdown([{ id: "q1", text: "Quoted", reply: "Comment" }], en);
  assert.doesNotMatch(quote, CJK_TEXT);
  for (const unit of ["image", "call", "million-tokens"]) {
    assert.doesNotMatch(compactImageQuoteSummary({ unit, rows: unit === "million-tokens" ? [] : [{ name: unit, amount: 1 }] }, en), CJK_TEXT);
  }
  const defaultCategory = { id: DEFAULT_SLASH_FAVORITE_CATEGORY_ID, name: DEFAULT_SLASH_FAVORITE_CATEGORY_NAME, keys: [] };
  assert.equal(slashFavoriteCategoryLabel(defaultCategory, en("favorites.defaultCategory")), en("favorites.defaultCategory"));
  assert.equal(slashFavoriteCategoryLabel({ ...defaultCategory, name: "Review" }, en("favorites.defaultCategory")), "Review");
});
