import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { installEnglishTestLocale, markupText, testTranslator } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
await installEnglishTestLocale(jiti);
const en = testTranslator("en");
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, canRestoreUserMessage, filterModelOptions, filterModelOptionsByProvider, getSlashCommandTrigger, buildSlashCommandValue, buildSlashCommandSelectionValue, buildCustomPromptValue, getCustomPromptsFromResponse, resolveSlashFavoriteLoad, filterSlashCommandsByTab, getSlashTabCounts, sortSlashCommandItems, getSlashCommandFavoriteKey, getSlashCommandDetails, normalizeSlashFavoriteKeys, reorderSlashFavoritesByDrop, isAsciiSlashKey, isSlashCommandInsertionPoint, getUpwardMenuMaxHeight, SlashCommandDetailsDialog, getUserMessageText, getUserMessageDraftImages, getDefaultGenOptions, getSessionGenOptions, insertAtSelection, getEditorSuggestionSuffix, getMarkdownListContinuation, appendTermsToDraft, stripTrailingTerms, createDraftPromptRequestController, canRunBuiltinSlashCommandWhileStreaming, offersBuiltinSlashCommandWhileStreaming, submitsSlashCommandOnEnter, canClearBuiltinCommandInput, hasStreamingMessagePayload } = await jiti.import("./ChatInput.tsx");
const { getMarkdownListContinuation: getMarkdownListEdit } = await jiti.import("../lib/markdown-list-continuation.ts");
const { isBareMcpCommand } = await jiti.import("../lib/mcp-command.ts");
const { buildAtInsertText, extractAtQuery } = await jiti.import("../lib/file-fuzzy.ts");
const { clearDraft, getDraft, mergeRestoredSubmissionDraft, mergeRestoredSubmissionText, rekeyDraft, setDraft } = await jiti.import("../lib/draft-store.ts");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const slashDetailsSurfaceSource = await readFile(new URL("./SlashCommandDetailsSurface.tsx", import.meta.url), "utf8");
const fileViewerModalSource = await readFile(new URL("./FileViewerModal.tsx", import.meta.url), "utf8");
const globalsCssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const chatWindowSourceForTest = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("inserts newline at the current selection without losing surrounding draft", () => {
  assert.deepEqual(insertAtSelection("alpha beta", 5, 5, "\n"), {
    value: "alpha\n beta",
    cursor: 6,
  });
  assert.deepEqual(insertAtSelection("alpha beta", 0, 5, "\n"), {
    value: "\n beta",
    cursor: 1,
  });
});

test("shows only the untyped suffix of a compatible editor suggestion", () => {
  assert.equal(getEditorSuggestionSuffix("", "继续检查并运行测试"), "继续检查并运行测试");
  assert.equal(getEditorSuggestionSuffix("继续", "继续检查并运行测试"), "检查并运行测试");
  assert.equal(getEditorSuggestionSuffix("修改", "继续检查并运行测试"), "");
  assert.equal(getEditorSuggestionSuffix("继续\n", "继续检查并运行测试"), "");
  assert.match(chatInputSource, /e\.key === "Tab" \|\| e\.key === "ArrowRight" \|\| e\.key === " "/);
  assert.match(chatInputSource, /showEditorSuggestion/);
});

test("a visible editor suggestion replaces the placeholder without losing the input label", () => {
  const html = composerMarkup({ editorSuggestion: "继续检查并运行测试" });
  assert.match(html, /继续检查并运行测试/);
  const textarea = html.match(/<textarea\b[^>]*>/)?.[0] ?? "";
  assert.match(textarea, /placeholder=""/);
  assert.match(textarea, /aria-label="[^"]+"/);
  assert.match(chatInputSource, /\[value, draftKey, isMobile, inputPlaceholder, showEditorSuggestion\]/);

  for (const props of [
    {},
    { editorSuggestion: "  " },
    { editorSuggestion: "继续检查并运行测试", readOnlyReason: "Read-only fixture" },
  ]) {
    const fallback = composerMarkup(props);
    assert.match(fallback.match(/<textarea\b[^>]*>/)?.[0] ?? "", /placeholder="[^"]+"/);
    assert.doesNotMatch(fallback, /继续检查并运行测试/);
  }
});

test("the composer centers its editor and uses the same padding for typed and suggested text", () => {
  const html = composerMarkup({ editorSuggestion: "继续检查并运行测试" });
  const wrapper = html.match(/<div style="position:relative;display:flex;flex:1;min-width:0[^"]*">/);
  assert.ok(wrapper, "the text field and suggestion share one flex item");
  assert.doesNotMatch(wrapper[0], /align-self:stretch/);
  const overlay = html.match(/<div aria-hidden="true" style="position:absolute;inset:0;[^"]*">/);
  assert.ok(overlay, "the visible suggestion has an overlay");
  const textarea = html.match(/<textarea\b[^>]*>/)?.[0] ?? "";
  for (const tag of [textarea, overlay[0]]) {
    assert.match(tag, /padding:2px 0/);
    assert.match(tag, /line-height:22px/);
  }
});

test("continues Markdown ordered lists when inserting a newline", () => {
  assert.equal(getMarkdownListContinuation("1. first", 8, 8), "\n2. ");
  assert.equal(getMarkdownListContinuation("  9) nested", 11, 11), "\n  10) ");
  assert.equal(getMarkdownListContinuation("1. first", 2, 2), "\n");
  assert.equal(getMarkdownListContinuation("1. first", 0, 5), "\n");
  assert.equal(getMarkdownListContinuation("plain text", 10, 10), "\n");
  assert.equal(getMarkdownListContinuation("1. ", 3, 3), "\n");
  assert.equal(getMarkdownListContinuation("1. first\n9. next", 16, 16), "\n10. ");
  assert.equal(getMarkdownListContinuation("1. first\nrest", 8, 8), "\n2. ");
  assert.match(chatInputSource, /e\.key === "Enter" && e\.shiftKey && !isComposing[\s\S]*insertNewline\(\)/);
});

test("offers a composer button for the Shift+Enter newline action", () => {
  assert.match(chatInputSource, /aria-keyshortcuts="Shift\+Enter"/);
  assert.match(chatInputSource, /chat\.insertNewline/);
  assert.match(chatInputSource, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("offers a composer button for slash commands with rounded border and aligned height", () => {
  assert.match(chatInputSource, /aria-label=\{t\("chat\.openSlashCommandMenu"\)\}/);
  assert.match(chatInputSource, /onClick=\{toggleSlashCommandMenu\}/);
  assert.match(chatInputSource, /<span aria-hidden="true">\/<\/span>/);
  assert.match(chatInputSource, /border:\s*"1px solid var\(--border\)"/);
  assert.match(chatInputSource, /borderRadius:\s*8/);
  assert.match(chatInputSource, /width:\s*32/);
  assert.match(chatInputSource, /height:\s*32/);
});

test("button and typed slash share the searchable panel", () => {
  assert.match(chatInputSource, /ref=\{slashSearchRef\}/);
  assert.match(chatInputSource, /chat\.searchSlashCommands/);
  assert.match(chatInputSource, /updateSlashSearch\(event\.currentTarget\.value\)/);
  assert.match(chatInputSource, /const slashMenuQuery = slashMenuOpenedByButton \? slashMenuSearch\.trim\(\)\.toLowerCase\(\) : slashQuery/);
  assert.match(chatInputSource, /activeSlashTab === "all" && favoriteCommands\.length > 0/);
});

test("opens the slash command panel directly without changing composer text or selection", () => {
  const handler = chatInputSource.match(/const openSlashCommandMenu = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/);
  assert.ok(handler, "the slash button should use a dedicated open action");
  assert.match(handler[0], /setSlashMenuOpenedByButton\(true\)/);
  assert.match(handler[0], /setSlashMenuOpen\(true\)/);
  assert.match(handler[0], /setSelectionRange\(start, end\)/);
  assert.doesNotMatch(handler[0], /insertAtSelection|setValue\(|setSlashCaret\(/);
  assert.match(chatInputSource, /const slashMenuQuery = slashMenuOpenedByButton \? slashMenuSearch/);
  assert.match(chatInputSource, /slashMenuOpen && slashMenuQuery !== null && \(/);
  assert.match(chatInputSource, /if \(slashActiveIndex >= displayedSlashCommands\.length\) \{/);
  assert.match(chatInputSource, /displayedSlashCommands\.length, slashActiveIndex/);
  const manualSlashHandler = chatInputSource.match(/const insertAsciiSlash = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[updateAtQuery\]\);/);
  assert.ok(manualSlashHandler);
  assert.match(manualSlashHandler[0], /setSlashMenuOpenedByButton\(false\)/);
  assert.match(chatInputSource, /const trigger: SlashCommandTrigger \| null = slashMenuOpenedByButton\s*\?\s*\{\s*placement: "start",\s*query: "",\s*draft: value\s*\}\s*:\s*slashTrigger/);
  assert.match(chatInputSource, /chat\.openSlashCommandMenu/);
  assert.equal(buildSlashCommandValue("compact", { placement: "start", query: "", draft: "保留现有文字" }), "/compact 保留现有文字");
});

test("both slash entry actions select custom prompts", () => {
  for (const name of ["openSlashCommandMenu", "insertAsciiSlash"]) {
    const calls = {};
    const valueRef = { current: "" };
    const setters = Object.fromEntries([
      "setSlashMenuOpenedByButton", "setSlashMenuSearch", "setSlashDetailCommand",
      "setSlashDetailContent", "setSlashDetailLoading", "setSlashDetailError",
      "setActiveSlashTab", "setSlashMenuOpen", "setSlashActiveIndex",
      "setHistoryMenuOpen", "setAtMenuOpen", "setValue", "setSlashCaret",
    ].map((key) => [key, (value) => { calls[key] = value; }]));
    chatInputCallback(name, {
      ...setters,
      textareaRef: { current: null },
      valueRef,
      slashDetailRequestRef: { current: 0 },
      insertAtSelection,
      updateAtQuery() {},
      requestAnimationFrame() {},
    })();
    assert.equal(calls.setActiveSlashTab, "customPrompt", name);
    if (name === "openSlashCommandMenu") {
      assert.equal(calls.setSlashMenuOpen, true);
      assert.equal(valueRef.current, "");
    } else {
      assert.equal(calls.setValue, "/");
      assert.equal(calls.setSlashCaret, 1);
    }
  }
});

test("offers prompt diagnosis and rewrite inside the composer", () => {
  assert.match(chatInputSource, /analyze_question_draft/);
  assert.match(chatInputSource, /DraftQuestionAnalysisDialog/);
  assert.match(chatInputSource, /draftAnalysisDialogOpen/);
  assert.match(chatInputSource, /contextMode: mode/);
  assert.match(chatInputSource, /type: "rewrite_question"/);
  assert.match(chatInputSource, /type: "rewrite_ste100"/);
  assert.match(chatInputSource, /createDraftPromptRequestController\(/);
  assert.match(chatInputSource, /draftSte100Rewrite/);
  assert.match(chatInputSource, /chat\.promptToolsSte100/);
  const termRewriteHandler = chatInputSource.slice(chatInputSource.indexOf("const runDraftRewrite"), chatInputSource.indexOf("const runDraftSte100Rewrite"));
  const ste100Handler = chatInputSource.slice(chatInputSource.indexOf("const runDraftSte100Rewrite"), chatInputSource.indexOf("const insertDraftTerms"));
  assert.doesNotMatch(termRewriteHandler, /setDraftSte100Rewrite\(\{ status: "idle" \}\)/);
  assert.doesNotMatch(ste100Handler, /setDraftRewrite\(\{ status: "idle" \}\)/);
  assert.match(chatInputSource, /chat\.promptToolsAnalyze/);
  assert.match(chatInputSource, /chat\.promptToolsRewrite/);
  assert.match(chatInputSource, /chat\.promptToolsApply/);
  assert.match(chatInputSource, /onEnsureSession/);
});

test("uses the same neutral composer treatment for terminology and STE100 buttons", () => {
  const toolbar = chatInputSource.slice(
    chatInputSource.indexOf("{/* Prompt diagnosis and rewrite stay in the composer"),
    chatInputSource.indexOf("{draftAnalysis.status === \"ready\" && ("),
  );
  assert.equal((toolbar.match(/border: "1px solid var\(--border\)"/g) ?? []).length, 2);
  assert.doesNotMatch(toolbar, /border: "1px solid var\(--accent\)"/);
  assert.doesNotMatch(toolbar, /color: canUseDraftPromptTools \? "var\(--accent\)"/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function promptHarness(resolveSessionId = async () => "session-1") {
  const state = {
    analysis: { status: "idle" },
    rewrite: { status: "idle" },
    ste100: { status: "idle" },
  };
  const requests = [];
  const setState = (key, update) => {
    state[key] = typeof update === "function" ? update(state[key]) : update;
  };
  const controller = createDraftPromptRequestController({
    requestIdRef: { current: 0 },
    resolveSessionId,
    send: async (sessionId, payload) => {
      const request = { sessionId, payload, deferred: deferred() };
      requests.push(request);
      return request.deferred.promise;
    },
    setAnalysis: (update) => setState("analysis", update),
    setRewrite: (update) => setState("rewrite", update),
    setSte100: (update) => setState("ste100", update),
    noResultMessage: "no result",
    failedMessage: "failed",
  });
  return { state, requests, controller };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("superseded prompt requests close loading without losing valid analysis", async () => {
  const first = promptHarness();
  const analysis = first.controller.runAnalysis("question", "draft");
  await nextTurn();
  const ste100 = first.controller.runSte100("draft");
  await nextTurn();
  assert.deepEqual(first.state.analysis, { status: "idle" });
  assert.deepEqual(first.state.ste100, { status: "loading" });
  assert.equal(first.requests.map(({ payload }) => payload.type).join(","), "analyze_question_draft,rewrite_ste100");

  first.requests[0].deferred.reject(new Error("late analysis failure"));
  await analysis;
  assert.deepEqual(first.state.ste100, { status: "loading" });
  assert.equal(first.requests.length, 2, "superseded analysis must not dispatch automatic rewrite");
  first.requests[1].deferred.resolve({ text: "STE result" });
  await ste100;
  assert.deepEqual(first.state.ste100, { status: "ready", result: { text: "STE result" } });

  const chained = promptHarness();
  const chainedAnalysis = chained.controller.runAnalysis("context", "draft");
  await nextTurn();
  chained.requests[0].deferred.resolve({ text: "terms" });
  await nextTurn();
  assert.deepEqual(chained.state.analysis, { status: "ready", result: { text: "terms" } });
  assert.deepEqual(chained.state.rewrite, { status: "loading" });
  const chainedSte100 = chained.controller.runSte100("draft");
  await nextTurn();
  assert.deepEqual(chained.state.rewrite, { status: "idle" });
  assert.deepEqual(chained.state.ste100, { status: "loading" });
  chained.requests[1].deferred.resolve({ text: "late automatic rewrite" });
  await chainedAnalysis;
  assert.deepEqual(chained.state.analysis, { status: "ready", result: { text: "terms" } });
  assert.deepEqual(chained.state.ste100, { status: "loading" });
  chained.requests[2].deferred.resolve({ text: "current STE" });
  await chainedSte100;
  assert.deepEqual(chained.state.ste100, { status: "ready", result: { text: "current STE" } });
  assert.deepEqual(chained.state.rewrite, { status: "idle" });
});

test("last prompt action wins across STE100, analysis, and manual rewrite", async () => {
  const analysisWins = promptHarness();
  const oldSte100 = analysisWins.controller.runSte100("draft");
  await nextTurn();
  const currentAnalysis = analysisWins.controller.runAnalysis("question", "draft");
  await nextTurn();
  assert.deepEqual(analysisWins.state.ste100, { status: "idle" });
  analysisWins.requests[0].deferred.resolve({ text: "late STE" });
  await oldSte100;
  analysisWins.requests[1].deferred.resolve({ text: "terms" });
  await nextTurn();
  analysisWins.requests[2].deferred.resolve({ text: "rewritten" });
  await currentAnalysis;
  assert.deepEqual(analysisWins.state.analysis, { status: "ready", result: { text: "terms" } });
  assert.deepEqual(analysisWins.state.rewrite, { status: "ready", result: { text: "rewritten" } });
  assert.deepEqual(analysisWins.state.ste100, { status: "idle" });

  const manualWins = promptHarness();
  manualWins.state.analysis = { status: "ready", result: { text: "terms" } };
  const oldSte = manualWins.controller.runSte100("draft");
  await nextTurn();
  const manual = manualWins.controller.runRewrite("draft", "terms");
  await nextTurn();
  assert.deepEqual(manualWins.state.ste100, { status: "idle" });
  assert.deepEqual(manualWins.state.rewrite, { status: "loading" });
  manualWins.requests[0].deferred.reject(new Error("late STE failure"));
  await oldSte;
  assert.deepEqual(manualWins.state.rewrite, { status: "loading" });
  manualWins.requests[1].deferred.resolve({ text: "manual result" });
  await manual;
  assert.deepEqual(manualWins.state.analysis, { status: "ready", result: { text: "terms" } });
  assert.deepEqual(manualWins.state.rewrite, { status: "ready", result: { text: "manual result" } });
  assert.deepEqual(manualWins.state.ste100, { status: "idle" });
  assert.match(chatInputSource, /\[draftKey, remotePeer, resetDraftPromptTools\]/);
  assert.match(chatInputSource, /disabled=\{!canUseDraftPromptTools \|\| draftSte100Rewrite\.status === "loading"\}/);
  assert.match(chatInputSource, /disabled=\{!canUseDraftPromptTools \|\| draftRewrite\.status === "loading"\}/);
});

test("reset invalidates session resolution and closes all prompt states", async () => {
  const session = deferred();
  const harness = promptHarness(() => session.promise);
  const analysis = harness.controller.runAnalysis("question", "draft");
  await nextTurn();
  harness.controller.reset();
  assert.deepEqual(harness.state, {
    analysis: { status: "idle" },
    rewrite: { status: "idle" },
    ste100: { status: "idle" },
  });
  session.resolve("session-1");
  await analysis;
  assert.equal(harness.requests.length, 0, "reset must stop the next request dispatch");
});

test("active prompt failures and empty results remain visible", async () => {
  const failure = promptHarness();
  const ste100 = failure.controller.runSte100("draft");
  await nextTurn();
  failure.requests[0].deferred.reject(new Error("provider failed"));
  await ste100;
  assert.deepEqual(failure.state.ste100, { status: "error", message: "provider failed" });

  const empty = promptHarness();
  empty.state.analysis = { status: "ready", result: { text: "terms" } };
  const rewrite = empty.controller.runRewrite("draft", "terms");
  await nextTurn();
  empty.requests[0].deferred.resolve({ text: "   " });
  await rewrite;
  assert.deepEqual(empty.state.analysis, { status: "ready", result: { text: "terms" } });
  assert.deepEqual(empty.state.rewrite, { status: "error", message: "no result" });
});

test("appends extracted terms to the end of the draft after a newline", () => {
  assert.equal(appendTermsToDraft("原始提问", "**术语A**：说明"), "原始提问\n**术语A**：说明");
  assert.equal(appendTermsToDraft("原始提问\n", "**术语A**：说明"), "原始提问\n**术语A**：说明");
  assert.equal(appendTermsToDraft("原始提问", "  **术语A**：说明  "), "原始提问\n**术语A**：说明");
  assert.equal(appendTermsToDraft("", "**术语A**：说明"), "**术语A**：说明");
  assert.equal(appendTermsToDraft("原始提问", "   "), "原始提问");
});

test("strips an appended terms block so a rewrite still sees the question alone", () => {
  assert.equal(stripTrailingTerms("原始提问\n**术语A**：说明", "**术语A**：说明"), "原始提问");
  assert.equal(stripTrailingTerms("原始提问", "**术语A**：说明"), "原始提问");
  assert.equal(stripTrailingTerms("**术语A**：说明", "**术语A**：说明"), "**术语A**：说明");
});

test("offers insert terms beside the extracted terminology", () => {
  assert.match(chatInputSource, /chat\.promptToolsInsertTerms/);
  assert.match(chatInputSource, /const insertDraftTerms = useCallback/);
  assert.match(chatInputSource, /appendTermsToDraft\(valueRef\.current, terms\)/);
});

test("keeps Fast mode independent from the reasoning-level control", () => {
  assert.match(chatInputSource, /fastMode && \(fastMode\.supported \|\| fastMode\.mode/);
  assert.match(chatInputSource, /onFastModeChange/);
  assert.match(chatInputSource, /chat-fast-mode/);
  assert.doesNotMatch(chatInputSource, /chat\.(?:fastModeDefaultDesc|fastModeDesc|standardModeDesc)/);
  assert.match(chatInputSource, /chat\.standardMode/);
  assert.match(chatInputSource, /<Zap/);
  assert.doesNotMatch(chatInputSource, /THINKING_LEVELS[^\n]*fast/);
});

test("shares the 12px ChatInput trigger while keeping each selector menu behavior", () => {
  assert.match(chatInputSource, /function ChatInputSelectTrigger/);
  assert.match(chatInputSource, /fontSize: 12/);
  assert.match(chatInputSource, /renderTrigger=\{\(\{ triggerRef, open, disabled, onToggle \}\)/);
  assert.match(chatInputSource, /<ChatInputSelectTrigger[\s\S]*onToggle=\{\(\) => \{[\s\S]*announceReaderMenuOpen\("chat-model"\)/);
  assert.match(chatInputSource, /<ChatInputSelectTrigger[\s\S]*onToggle=\{\(\) => \{[\s\S]*announceReaderMenuOpen\("chat-fast-mode"\)/);
  assert.match(chatInputSource, /<SelectorRow[\s\S]*disabled=\{mode === "fast" && !fastMode\.supported\}/);
  assert.match(chatInputSource, /<span style=\{\{ flex: 1 \}\}>\{mode\}<\/span>/);
  assert.match(chatInputSource, /<span aria-hidden="true" style=\{\{ width: 10, flexShrink: 0 \}\} \/>/);
  assert.match(chatInputSource, /<SelectorRow[\s\S]*onToolPresetChange\(preset\)/);
});
test("keeps reasoning and Fast mode visible while streaming", () => {
  assert.match(chatInputSource, /fastMode && \(fastMode\.supported \|\| fastMode\.mode !== "default"\) && onFastModeChange/);
  assert.match(chatInputSource, /onThinkingLevelChange &&/);
  assert.match(chatInputSource, /mobileControlsVisible \? "flex" : "none"/);
  assert.match(chatInputSource, /showLabel=\{!isMobile \|\| controlsMenuOpen \|\| isStreaming\}/);
  assert.match(chatInputSource, /setFastModeDropdownOpen\(false\);\s*setThinkingDropdownOpen\(false\);/);
});

test("keeps mobile editable controls at iOS-safe size and expanded controls in flow", () => {
  assert.match(chatInputSource, /const mobileControlsVisible = isMobile && \(controlsMenuOpen \|\| isStreaming \|\| canStop\);/);
  assert.match(chatInputSource, /fontSize: isMobile \? 16 : 14/);
  assert.match(chatInputSource, /fontSize: isMobile \? 16 : 11/);
  assert.match(chatInputSource, /gridColumn: "1 \/ -1", gridRow: 2/);

  const controlsStart = chatInputSource.indexOf('display: isMobile ? (mobileControlsVisible ? "flex" : "none") : "flex"');
  const controlsEnd = chatInputSource.indexOf('justifyContent: "flex-end"', controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart);
  const controlsStyle = chatInputSource.slice(controlsStart, controlsEnd);
  assert.match(controlsStyle, /position: "static"/);
  assert.match(controlsStyle, /width: "100%"/);
  assert.match(controlsStyle, /flexWrap: "wrap"/);
  assert.doesNotMatch(controlsStyle, /position: "absolute"/);
});

test("cleans mobile composer streaming action bar and hides disabled compaction clutter", () => {
  assert.match(chatInputSource, /\(onCompact \|\| onAutoCompactionChange\) && \(!isMobile \|\| controlsMenuOpen \|\| isCompacting\)/);
  const controlsStart = chatInputSource.indexOf('display: isMobile ? (mobileControlsVisible ? "flex" : "none") : "flex"');
  const controlsEnd = chatInputSource.indexOf('justifyContent: "flex-end"', controlsStart);
  assert.ok(controlsStart >= 0 && controlsEnd > controlsStart);
  const controlsStyle = chatInputSource.slice(controlsStart, controlsEnd);
  assert.doesNotMatch(controlsStyle, /boxShadow/);
  assert.doesNotMatch(controlsStyle, /backdropFilter/);
  assert.doesNotMatch(controlsStyle, /border:/);
});
test("does not show prompt tools for an empty composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        sessionId: "session-1",
      }),
    ),
  );

  assert.doesNotMatch(html, /Prompt diagnosis|提示词诊断/);
  assert.ok(!html.includes(markupText(en("questionAnalysis.analyze"))));
  assert.doesNotMatch(html, /STE100 rewrite|STE100 改写/);
});

test("renders terminology diagnosis for a non-empty draft", () => {
  const draftKey = "prompt-tools-render-test";
  clearDraft(draftKey);
  setDraft(draftKey, { value: "如何优化这个问题？", images: [] });
  try {
    const html = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(ChatInput, {
          onSend() {},
          onAbort() {},
          isStreaming: false,
          draftKey,
          sessionId: "session-1",
        }),
      ),
    );

    assert.ok(html.includes(markupText(en("questionAnalysis.analyze"))));
    assert.match(html, /STE100 rewrite|STE100 改写/);
    assert.ok(!html.includes(markupText(en("questionAnalysis.rewrite"))));
  } finally {
    clearDraft(draftKey);
  }
});

test("keeps terminology tools visible while the assistant is running", () => {
  const draftKey = "prompt-tools-streaming-test";
  clearDraft(draftKey);
  setDraft(draftKey, { value: "如何优化这个问题？", images: [] });
  try {
    const html = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(ChatInput, {
          onSend() {},
          onAbort() {},
          isStreaming: true,
          draftKey,
          sessionId: "session-1",
        }),
      ),
    );

    assert.ok(html.includes(markupText(en("questionAnalysis.analyze"))));
  } finally {
    clearDraft(draftKey);
  }
});

test("hides composer scrollbars without disabling long-message scrolling", () => {
  assert.match(chatInputSource, /className="chat-input-textarea"/);
  assert.match(chatInputSource, /overflowX: "hidden"/);
  assert.match(chatInputSource, /overflowY: "auto"/);
  assert.match(globalsCssSource, /\.chat-input-textarea \{[\s\S]*scrollbar-width: none/);
  assert.match(globalsCssSource, /\.chat-input-textarea::\-webkit-scrollbar \{[\s\S]*display: none/);
});

test("triggers slash commands at either draft boundary and normalizes command to front", () => {
  const start = getSlashCommandTrigger("/已有文字", 1);
  assert.deepEqual(start, { placement: "start", query: "", draft: "已有文字" });
  assert.equal(buildSlashCommandValue("compact", start), "/compact 已有文字");

  const end = getSlashCommandTrigger("已有文字/", "已有文字/".length);
  assert.deepEqual(end, { placement: "end", query: "", draft: "已有文字" });
  assert.equal(buildSlashCommandValue("compact", end), "/compact 已有文字");

  const typedEnd = getSlashCommandTrigger("已有文字/co", "已有文字/co".length, ["compact"]);
  assert.deepEqual(typedEnd, { placement: "end", query: "co", draft: "已有文字" });
  assert.equal(buildSlashCommandValue("compact", typedEnd), "/compact 已有文字");

  const inlineTextSlash = getSlashCommandTrigger("明细/历史用量这一项，", "明细/历史用量这一项，".length, ["compact"]);
  assert.equal(inlineTextSlash, null);

  const typed = getSlashCommandTrigger("/comp", "/comp".length);
  assert.deepEqual(typed, { placement: "start", query: "comp", draft: "" });
  assert.equal(buildSlashCommandValue("compact", typed), "/compact ");

  const typedBeforeDraft = getSlashCommandTrigger("/co已有文字", 3);
  assert.deepEqual(typedBeforeDraft, { placement: "start", query: "co", draft: "已有文字" });
  assert.equal(buildSlashCommandValue("compact", typedBeforeDraft), "/compact 已有文字");
});

test("filters slash commands by category and preserves configured custom-prompt order", () => {
  const commands = [
    { name: "second", description: "", source: "customPrompt", promptId: "p2", content: "second", order: 2 },
    { name: "compact", description: "", source: "builtin" },
    { name: "native", description: "", source: "prompt" },
    { name: "first", description: "", source: "customPrompt", promptId: "p1", content: "first", order: 1 },
  ];

  assert.deepEqual(getSlashTabCounts(commands), {
    favorites: 0, all: 4, customPrompt: 2, builtin: 1, extension: 0, prompt: 1, skill: 0,
  });
  assert.deepEqual(filterSlashCommandsByTab(commands, "customPrompt").map((command) => command.name), ["second", "first"]);
  assert.deepEqual(filterSlashCommandsByTab(commands, "all"), commands);
  assert.deepEqual(sortSlashCommandItems(commands.filter((command) => command.source === "customPrompt"), "", (key) => key).map((command) => command.name), ["first", "second"]);
});

test("skill slash search ranks the bare exact name before prefixes and substrings", () => {
  const commands = [
    { name: "skill:alpha-review", description: "", source: "skill" },
    { name: "skill:review-tools", description: "", source: "skill" },
    { name: "skill:review", description: "", source: "skill" },
    { name: "skill:notes", description: "review", source: "skill" },
  ];
  assert.deepEqual(sortSlashCommandItems(commands, "review", key => key).map(command => command.name), [
    "skill:review", "skill:review-tools", "skill:alpha-review", "skill:notes",
  ]);
  assert.equal(sortSlashCommandItems(commands, "skill:review", key => key)[0].name, "skill:review");
});

test("favorite slash items have stable keys and deterministic drop/remove behavior", () => {
  const skill = { name: "skill:review", description: "", source: "skill" };
  const prompt = { name: "Review", description: "", source: "customPrompt", promptId: "p1", content: "review", order: 0 };
  assert.equal(getSlashCommandFavoriteKey(skill), "skill:skill:review");
  assert.equal(getSlashCommandFavoriteKey(prompt), "customPrompt:p1");
  assert.deepEqual(normalizeSlashFavoriteKeys([" skill:review ", "skill:review", "", 3, " prompt:x "]), ["skill:review", "prompt:x"]);
  assert.deepEqual(resolveSlashFavoriteLoad({ favorites: { keys: [] } }, 200, ["skill:stale"]), { keys: [], fallback: false, available: true });
  assert.deepEqual(resolveSlashFavoriteLoad({ code: "slash_favorites_read_failed" }, 503, ["skill:stale"]), { keys: [], fallback: false, available: false });
  assert.deepEqual(resolveSlashFavoriteLoad({ code: "slash_favorites_unsupported" }, 501, [" skill:stale "]), { keys: ["skill:stale"], fallback: true, available: false });
  assert.deepEqual(reorderSlashFavoritesByDrop(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(reorderSlashFavoritesByDrop(["a", "b", "c"], "b", "c"), ["a", "b", "c"]);
  assert.deepEqual(reorderSlashFavoritesByDrop(["a", "b", "c"], "a", "c"), ["b", "a", "c"]);
  assert.equal(getSlashCommandDetails({ name: "Review", description: "short", source: "customPrompt", promptId: "p1", content: "full prompt", order: 0 }, (key) => key), "full prompt");
});

test("clears custom prompts after a valid load is followed by a malformed response", () => {
  const prompt = { id: "p1", title: "Review", content: "review", description: "", order: 0, updatedAt: 1 };
  let loaded = getCustomPromptsFromResponse({ prompts: [prompt] });
  assert.deepEqual(loaded, [prompt]);
  loaded = getCustomPromptsFromResponse({ prompts: [{ id: "p1", title: "Review" }] });
  assert.deepEqual(loaded, []);
  assert.match(chatInputSource, /setCustomPrompts\(\[\]\)/);
});

test("selecting a custom prompt inserts its full content and keeps the draft", () => {
  const content = "Follow these rules exactly.\nKeep the original intent.";
  const prompt = {
    name: "Review", description: "", source: "customPrompt", promptId: "p1", content, order: 0,
  };
  const start = getSlashCommandTrigger("/review", "/review".length);
  assert.equal(buildCustomPromptValue(content, start), content);
  assert.equal(buildSlashCommandSelectionValue(prompt, start), content);

  const draft = "Please review this change";
  const endText = `${draft} /review`;
  const end = getSlashCommandTrigger(endText, endText.length, ["Review"]);
  assert.equal(buildSlashCommandSelectionValue(prompt, end), `${content}\n\n${draft} `);
  assert.equal(buildSlashCommandSelectionValue({ name: "compact", description: "", source: "builtin" }, start), "/compact " );
});

test("searches custom prompt bodies, preserves configured order, and keeps raw draft whitespace", () => {
  const first = { name: "Alpha", description: "", source: "customPrompt", promptId: "p1", content: "tail-only marker", order: 2 };
  const second = { name: "Beta", description: "", source: "customPrompt", promptId: "p2", content: "other", order: 1 };
  assert.match(chatInputSource, /content\.includes\(slashMenuQuery\)/);
  assert.deepEqual(sortSlashCommandItems([first], "tail-only", (key) => key).map((item) => item.name), ["Alpha"]);
  assert.deepEqual(sortSlashCommandItems([first, second], "", (key) => key).map((item) => item.name), ["Beta", "Alpha"]);
  assert.equal(buildCustomPromptValue("preset", { placement: "start", query: "", draft: "  keep spaces  " }), "preset\n\n  keep spaces  ");
  assert.equal(buildCustomPromptValue("", { placement: "start", query: "", draft: "  keep spaces  " }), "  keep spaces  ");
});

test("renders favorite drag ordering, details, server persistence, and accessible category counts", () => {
  assert.match(chatInputSource, /const canDragFavorite =/);
  assert.match(chatInputSource, /draggable=\{canDrag/);
  assert.match(chatInputSource, /onClick=\{\(\) => applySlashCommand\(command\)\}/);
  assert.match(chatInputSource, /reorderSlashFavoritesByDrop/);
  assert.match(chatInputSource, /fetch\(apiPath\("slash-command-favorites"\)/);
  assert.match(chatInputSource, /chat\.viewSlashCommandDetails/);
  assert.match(chatInputSource, /fileApiPath\(sourcePath, "read"/);
  assert.match(chatInputSource, /aria-label=\{`\$\{t\(SLASH_TAB_LABEL_KEYS\[tab\]\)\} · \$\{slashTabCounts\[tab\]\}`\}/);
});

test("renders favorite controls and first-position favorites tab", () => {
  assert.match(chatInputSource, /chat\.favoriteSlashCommand/);
  assert.match(chatInputSource, /chat\.unfavoriteSlashCommand/);
  assert.match(chatInputSource, /activeSlashTab === "all" && favoriteCommands\.length > 0/);
  const actionsVisibility = chatInputSource.slice(
    chatInputSource.indexOf("const actionsVisible ="),
    chatInputSource.indexOf("return (", chatInputSource.indexOf("const actionsVisible =")),
  );
  assert.doesNotMatch(actionsVisibility, /\|\|\s*favorite/);
  assert.match(chatInputSource, /onFocusCapture=\{\(\) => setSlashHoveredKey\(favoriteKey\)\}/);
  assert.match(chatInputSource, /onBlurCapture=\{\(event\) => \{/);
  assert.doesNotMatch(chatInputSource, /moveSlashFavorite|moveFavoriteUp|moveFavoriteDown/);
  assert.match(chatInputSource, /localStorage\.setItem\(SLASH_FAVORITES_STORAGE_KEY/);
});

test("renders slash category filters and loads saved prompts for boundary queries", () => {
  assert.match(chatInputSource, /role="group"[\s\S]*aria-label=\{t\("chat\.slashCommandCategories"\)\}/);
  assert.match(chatInputSource, /aria-pressed=\{active\}/);
  assert.match(chatInputSource, /setActiveSlashTab\(tab\);\s+setSlashActiveIndex\(0\)/);
  assert.match(chatInputSource, /fetch\(apiPath\("custom-prompts"\)/);
  assert.match(chatInputSource, /void loadCustomPrompts\(\);/);
  const trailingPromptQuery = getSlashCommandTrigger("Existing request /rev", "Existing request /rev".length, ["Review"]);
  assert.equal(trailingPromptQuery?.query, "rev");
  assert.match(chatInputSource, /window\.addEventListener\(CUSTOM_PROMPTS_CHANGED_EVENT/);
  assert.match(chatInputSource, /buildSlashCommandSelectionValue\(command, trigger\)/);
});

test("uses the physical slash key without hijacking modified shortcuts", () => {
  const base = { code: "Slash", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(isAsciiSlashKey({ ...base, key: "、" }), true);
  assert.equal(isAsciiSlashKey({ ...base, key: "?", shiftKey: true }), false);
  assert.equal(isAsciiSlashKey({ ...base, key: "/", metaKey: true }), false);
});

test("only treats slash insertion at command boundaries as a command trigger", () => {
  assert.equal(isSlashCommandInsertionPoint("", 0, 0), true);
  assert.equal(isSlashCommandInsertionPoint("draft", 5, 5), true);
  assert.equal(isSlashCommandInsertionPoint("draft", 2, 3), false);
  assert.equal(isSlashCommandInsertionPoint("/compact", 8, 8), false);
});

test("ends the slash command trigger at the first whitespace", () => {
  assert.equal(getSlashCommandTrigger("/compact ", 9, ["compact"]), null);
});

test("sends composer generation options using the image-gen API field names", () => {
  assert.match(chatInputSource, /field === "size" \? \{ size: value \}/);
  assert.match(chatInputSource, /field === "resolution" \? \{ resolution: value \}/);
  assert.match(chatInputSource, /\{ quality: value \}/);
  assert.match(chatInputSource, /postImageGen\(\{ action: "setGenOptions", \.\.\.request \}\)/);
  assert.doesNotMatch(chatInputSource, /postImageGen\(\{ action: "setGenOptions", \.\.\.localNext \}\)/);
});

test("generation-option writes do not block ordinary prompt admission", async () => {
  assert.match(chatInputSource, /const genWriteQueueRef = useRef<Promise<unknown>>\(Promise\.resolve\(\)\)/);
  assert.match(chatInputSource, /const requestBody = requestSessionFile \? \{ \.\.\.body, sessionFile: requestSessionFile \} : body/);
  assert.doesNotMatch(chatInputSource, /await genWriteQueueRef\.current/);
  assert.doesNotMatch(chatInputSource, /if \(!sessionFile\) return null;/);

  const gate = deferred();
  const sent = [];
  const handleSend = chatInputCallback("handleSend", {
    value: "发布",
    attachedImages: [],
    quotes: [],
    onAudioUnlock() {},
    isStreaming: false,
    statePending: false,
    builtinCommandPendingRef: { current: false },
    genWriteQueueRef: { current: gate.promise },
    draftAnalysis: { status: "idle" },
    draftAnalysisQuestionRef: { current: null },
    draftRewrite: { status: "idle" },
    offersBuiltinSlashCommandWhileStreaming,
    runBuiltinCommand: async () => false,
    clearInput() {},
    onSend: (message) => sent.push(message),
  });

  const sending = handleSend();
  await nextTurn();
  assert.deepEqual(sent, ["发布"]);
  gate.resolve();
  await sending;
});

test("persists only explicit generation options into each session", () => {
  const state = {
    enabled: true,
    genModelId: "gpt-image-2",
    genInvalid: false,
    genSize: "3:2",
    genResolution: "2k",
    genQuality: null,
    capabilities: {
      "gpt-image-2": { ratios: ["auto", "1:1", "3:2"], resolutions: ["1k", "2k"], qualities: [] },
    },
  };
  assert.deepEqual(getSessionGenOptions(state), { size: "3:2", resolution: "2k" });
  assert.match(chatInputSource, /if \(Object\.keys\(pendingGenOptions\)\.length > 0\) void postImageGen\(\{ action: "setGenOptions", \.\.\.pendingGenOptions \}\)/);
  assert.doesNotMatch(chatInputSource, /const options = \{ \.\.\.getSessionGenOptions\(genState\)/);
});

test("cleared generation options do not become session overrides", () => {
  assert.deepEqual(getSessionGenOptions({ genSize: "16:9", genResolution: "1k", genQuality: "high", genOptionsUnset: ["size", "quality"] }), { resolution: "1k" });
  assert.match(chatInputSource, /action: "clearGenOptions", fields: \[field\]/);
  assert.match(chatInputSource, /GEN_OPTION_REQUEST/);
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: {
        code: "MODEL_RUNTIME_ERROR",
        message: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
        logPath: "/home/test/.local/state/pi-web-reader/model-errors.log",
      },
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model configuration warning/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
  assert.match(html, /diagnostics:/);
  assert.match(html, /pi-web-reader\/model-errors\.log/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("long queues scroll their rows without moving Recall or the composer", () => {
  const steering = Array.from({ length: 20 }, (_, index) => ({ itemId: `s-${index}`, text: `message-${index}`, hasImages: index === 0 }));
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
    onSend() {}, onAbort() {}, onRecallQueue() {}, isStreaming: true,
    queuedMessages: { steering, followUp: [{ itemId: "f-0", text: "last-followup", hasImages: false }] },
  })));
  const list = html.indexOf('role="region"');
  assert.ok(list >= 0, "queued messages have a keyboard-accessible scrolling region");
  assert.match(html.slice(list, list + 300), /max-height:min\(180px.*overflow-y:auto/);
  assert.match(html.slice(0, list), /Recall/);
  assert.ok(html.indexOf("last-followup", list) < html.indexOf("chat-input-textarea", list));
  assert.equal([...html.matchAll(/title="message-\d+"/g)].length, 20);
});

test("keeps image attachment controls enabled for queued streaming messages", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onSteer() {},
        onFollowUp() {},
        isStreaming: true,
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  const attachTitleIndex = html.search(/title="(?:Attach image|附加图片)"/);
  const attachStart = html.lastIndexOf("<button", attachTitleIndex);
  const attachEnd = html.indexOf("</button>", attachStart);
  assert.ok(attachStart >= 0 && attachEnd > attachStart);
  assert.doesNotMatch(html.slice(attachStart, attachEnd), /disabled/);
});

test("keeps the compaction status control visible while compacting", () => {
  assert.match(chatInputSource, /onCompact \|\| onAutoCompactionChange/);
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelScopeWarningBanner, {
      warnings: ['No models match pattern "ghost-gateway/*"'],
    }),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(renderToStaticMarkup(React.createElement(ModelScopeWarningBanner, { warnings: [] })), "");
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: {
          code: "MODEL_DISCOVERY_FAILED",
          message: "Model discovery failed: dependency load failed",
          logPath: "/home/test/.local/state/pi-web-reader/model-errors.log",
        },
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />Model error</);
  assert.match(html, /title="Model discovery failed"/);
  assert.match(html, />Model discovery failed</);
});

test("renders the read-only tool preset as the active selection", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "read-only",
      }),
    ),
  );

  assert.match(html, /title="(Change tool preset|更改工具预设): read-only"/);
  assert.match(html, />read-only<\/span>/);
});

test("configured tools are displayed and can be selected instead of default", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onToolPresetChange() {}, isStreaming: false, toolPreset: "configured",
    })),
  );
  assert.match(html, /title="Change tool preset: Configured"/);
  assert.match(chatInputSource, /TOOL_PRESETS = \["configured", "off", "read-only", "default", "full"\]/);
  assert.match(chatInputSource, /configured: "configured"/);
  assert.match(chatInputSource, /lvl === "configured"\) desc = t\("chat\.configuredToolsDescription"\)/);
  assert.match(chatInputSource, /if \(!isActive\) onToolPresetChange\(preset\)/);
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  assert.match(html, /title="Switching model"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("filters model options by provider, name, id and scoped identity", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "OpenAI"), [options[2]]);
  assert.deepEqual(filterModelOptions(options, "anthropic/claude"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "anthropic/Claude Sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("filters hidden providers from the model selector", () => {
  const options = [
    { provider: "Sub2API GPT", modelId: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { provider: "Sub2API Grok", modelId: "grok-4.5", name: "Grok 4.5" },
    { provider: "Sub2API Claude", modelId: "claude-sonnet-5", name: "Claude Sonnet 5" },
  ];

  assert.deepEqual(
    filterModelOptionsByProvider(options, new Set(["Sub2API Grok"])),
    [options[0], options[2]],
  );
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
});

test("a bare /mcp reaches the built-in handler while a run is active", () => {
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/compact"), false);
  // Subcommands act on the session's connections and are queued like any message.
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp login docs"), false);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp:1"), false);
  // The built-in list itself is unchanged: /mcp is not one of the composer's built-ins.
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/mcp"), false);
});

test("Enter on pi's built-in /mcp submits it at once; other extension commands still complete first", () => {
  const builtinMcp = { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" } };
  const otherMcp = { ...builtinMcp, sourceInfo: { ...builtinMcp.sourceInfo, path: "/ext/mcp.ts" } };
  const copy = { name: "copy", description: "", source: "builtin", availableWhileStreaming: true };
  const compact = { name: "compact", description: "", source: "builtin" };

  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, false), true);
  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, true), true);
  assert.equal(submitsSlashCommandOnEnter("/mc", builtinMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/mcp", otherMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/deploy", { ...otherMcp, name: "deploy" }, false), false);
  // The composer's built-ins keep their rule: typed in full, and while streaming only those allowed then.
  assert.equal(submitsSlashCommandOnEnter("/copy", copy, true), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, false), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, true), false);
  assert.equal(submitsSlashCommandOnEnter("/co", copy, false), false);

  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(sourceText, /if \(sendShortcut && !slashMenuOpenedByButton && submitsSlashCommandOnEnter\(value, selectedCommand, isStreaming\)\) \{/);
});

function chatInputCallback(name, context) {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    return ts.forEachChild(node, findCallback);
  }
  return new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

test("while a run streams, a bare /mcp opens Settings or is queued as before", async () => {
  const run = async (value, handled, { mode = "steer", images = [] } = {}) => {
    const calls = { builtin: [], prompts: [], cleared: 0 };
    const quotes = [];
    const sendQueued = chatInputCallback("sendQueued", {
      value,
      attachedImages: images,
      quotes,
      valueRef: { current: value },
      attachedImagesRef: { current: images },
      quotesRef: { current: quotes },
      hasStreamingMessagePayload,
      onAudioUnlock() {},
      clearInput() { calls.cleared += 1; },
      onBuiltinCommand: async () => ({ handled }),
      canRunBuiltinSlashCommandWhileStreaming,
      isBareMcpCommand,
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      onPromptWithStreamingBehavior: (message, behavior, attached) => calls.prompts.push([message, behavior, attached?.length ?? 0]),
      onSteer() { throw new Error("slash messages are prompts"); },
      onFollowUp() { throw new Error("slash messages are prompts"); },
    });
    sendQueued(mode);
    await new Promise((resolve) => setImmediate(resolve));
    return calls;
  };

  // Owned: Settings opened, nothing queued, the handler clears the input itself.
  assert.deepEqual(await run("/mcp", true), { builtin: ["/mcp"], prompts: [], cleared: 0 });
  // Another extension's /mcp: queued exactly as before.
  assert.deepEqual(await run("/mcp", false), { builtin: ["/mcp"], prompts: [["/mcp", "steer", 0]], cleared: 1 });
  assert.deepEqual(await run("/mcp", false, { mode: "followup" }), { builtin: ["/mcp"], prompts: [["/mcp", "followUp", 0]], cleared: 1 });
  // Subcommands and a /mcp with images never reach the handler.
  assert.deepEqual(await run("/mcp login docs", true), { builtin: [], prompts: [["/mcp login docs", "steer", 0]], cleared: 1 });
  assert.deepEqual(await run("/mcp", true, { images: [{}] }), { builtin: [], prompts: [["/mcp", "steer", 1]], cleared: 1 });
  // The composer's own built-ins are unchanged.
  assert.deepEqual(await run("/copy", true), { builtin: ["/copy"], prompts: [], cleared: 0 });
});

test("handleSend lets a handled /mcp through while streaming and sends an unowned one when idle", async () => {
  const run = async (value, { isStreaming, handled }) => {
    const calls = { builtin: [], sent: [] };
    const handleSend = chatInputCallback("handleSend", {
      value,
      attachedImages: [],
      onAudioUnlock() {},
      isStreaming,
      statePending: false,
      builtinCommandPendingRef: { current: false },
      genWriteQueueRef: { current: Promise.resolve() },
      draftAnalysis: { status: "idle" },
      draftAnalysisQuestionRef: { current: null },
      draftRewrite: { status: "idle" },
      offersBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      clearInput() {},
      onSend: (message) => calls.sent.push(message),
    });
    await handleSend();
    return calls;
  };
  assert.deepEqual(await run("/mcp", { isStreaming: true, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: false }), { builtin: ["/mcp"], sent: ["/mcp"] });
  // Streaming without steer handlers keeps any other message in the composer, as before.
  assert.deepEqual(await run("/mcp login", { isStreaming: true, handled: false }), { builtin: [], sent: [] });
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("keeps @ file completion and Escape cancellation local to the composer", () => {
  assert.deepEqual(extractAtQuery("保留原文 @src/"), {
    start: 5,
    query: "src/",
    quoted: false,
  });
  assert.deepEqual(buildAtInsertText("src/components", true), {
    text: "@src/components/",
    cursorOffset: "@src/components/".length,
  });
  assert.deepEqual(buildAtInsertText("docs/my file.md", false), {
    text: '@"docs/my file.md" ',
    cursorOffset: '@"docs/my file.md" '.length,
  });
  assert.deepEqual(buildAtInsertText("docs/my dir", true, true), {
    text: '@"docs/my dir/"',
    cursorOffset: '@"docs/my dir/"'.length - 1,
  });

  const atMenuStart = chatInputSource.indexOf("      // @ file menu");
  const atMenuEnd = chatInputSource.indexOf('      if (e.key === "Enter"', atMenuStart);
  assert.ok(atMenuStart >= 0 && atMenuEnd > atMenuStart, "@ menu key handler should remain explicit");
  const atMenuHandler = chatInputSource.slice(atMenuStart, atMenuEnd);
  assert.match(atMenuHandler, /if \(e\.key === "Escape"\) \{[\s\S]*?setAtMenuOpen\(false\);[\s\S]*?return;/);
  assert.doesNotMatch(atMenuHandler, /setValue\(|setSelectionRange\(|setAttachedImages\(|clearDraft\(|setDraft\(/);
  assert.match(chatInputSource, /atMenuOpen && atQuery !== null && !isComposing/);
  assert.match(chatInputSource, /const before = value\.slice\(0, atQuery\.start\)/);
  assert.match(chatInputSource, /const newPos = before\.length \+ insert\.cursorOffset/);
});

test("routes @ file completion through the per-project Git visibility setting", () => {
  assert.match(chatInputSource, /explorer-filter\?cwd=/);
  assert.match(chatInputSource, /EXPLORER_FILTER_CHANGED_EVENT/);
  assert.match(chatInputSource, /fileIndexRequestPath\(fetchCwd, query, hideGitIgnored\)/);
  assert.match(chatInputSource, /params\.set\("hideGitIgnored", "1"\)/);
});

test("guards visibility and file-index responses against toggles, cwd changes, and remote peers", () => {
  assert.match(chatInputSource, /explorerFilterRequestIdRef/);
  assert.match(chatInputSource, /explorerFilterAbortRef/);
  assert.match(chatInputSource, /data\.filter \?\? \(remotePeer \? null : loadStoredExplorerFilter\(fetchCwd\)\)/);
  assert.match(chatInputSource, /fileIndexRequestIdRef\.current !== requestId/);
  assert.match(chatInputSource, /serverSearchRequestIdRef\.current !== requestId/);
  assert.match(chatInputSource, /fetch\(apiPath\(fileIndexRequestPath\(fetchCwd, query, hideGitIgnored\)\), \{ signal: controller\.signal \}\)/);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeRestoredSubmissionText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeRestoredSubmissionDraft("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

test("moves a provisional new-session draft to the real session key", () => {
  const provisionalKey = "new:/tmp/rekey-test";
  const sessionKey = "session-rekey-test";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "queued while preflight ran", images: [] });

  assert.deepEqual(rekeyDraft(provisionalKey, sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });

  clearDraft(sessionKey);
});

test("rekey keeps a synchronously restored draft when React state is still empty", () => {
  const provisionalKey = "new:/tmp/rekey-race";
  const sessionKey = "session-rekey-race";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "restored before state flush", images: [] });

  assert.deepEqual(
    rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }),
    { value: "restored before state flush", images: [] },
  );
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "restored before state flush",
    images: [],
  });

  clearDraft(sessionKey);
});

test("renders the current-session automatic compaction segment beside manual compaction", () => {
  assert.match(chatInputSource, /autoCompactionEnabled/);
  assert.match(chatInputSource, /onAutoCompactionChange/);
  assert.match(chatInputSource, /chat\.autoCompaction/);
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onCompact() {}, onAbortCompaction() {},
      autoCompactionEnabled: true, onAutoCompactionChange() {}, isCompacting: true,
      isStreaming: true, unattended: true, onUnattendedChange() {},
    })),
  );
  assert.match(html, /border:1px solid rgba\(239,68,68,0\.3\)/);
  assert.match(html, /border:1px solid rgba\(59, 130, 246, 0\.32\)/);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("explains when an automatic retry stopped and awaits the user", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        continueUi: { kind: "stopped", reason: "fatal", errorText: "invalid api key" },
        unattended: true,
        onContinue() {},
      }),
    ),
  );

  assert.match(html, /role="status"/);
  assert.ok(html.includes(markupText(en("chat.autoRetryStopped"))));
  assert.ok(html.includes(markupText(en("chat.continueManual"))));
});

test("turns visible capability fallbacks into persisted generation options", () => {
  assert.deepEqual(getDefaultGenOptions({
    enabled: true,
    genModelId: "gpt-image-2",
    genInvalid: false,
    genSize: null,
    genResolution: null,
    genQuality: null,
    capabilities: {
      "gpt-image-2": { ratios: ["auto", "1:1"], resolutions: ["1k", "2k"], qualities: [] },
    },
  }), { size: "auto", resolution: "1k" });
});


test("does not default unsupported chat-completions options", () => {
  assert.deepEqual(getDefaultGenOptions({
    enabled: true,
    genModelId: "gemini-3.1-flash-image",
    genInvalid: false,
    genSize: "16:9",
    genResolution: "4K",
    genQuality: "high",
    capabilities: { "gemini-3.1-flash-image": { resolutions: [] } },
  }), {});
});


test("uses integer desktop/mobile composer line boxes", () => {
  assert.match(chatInputSource, /fontSize: isMobile \? 16 : 14,[\s\S]*?lineHeight: isMobile \? "26px" : "22px",/);
});

function composerMarkup(props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false, ...props })));
}

test("empty-session auto control does not require manual compaction and unknown is not off", () => {
  const html = composerMarkup({ onAutoCompactionChange() {}, autoCompactionEnabled: true });
  assert.doesNotMatch(html, /aria-label="(?:Compact context|压缩上下文)"/);
  assert.match(html, /aria-pressed="true"/);
  const unknown = composerMarkup({ onAutoCompactionChange() {}, autoCompactionEnabled: null });
  assert.match(unknown, /aria-busy="true"/);
  assert.doesNotMatch(unknown, /aria-pressed="false"/);
});

test("runtime settings control adapts to its label and keeps a visible retry", () => {
  const base = { onCompact() {}, onAutoCompactionChange() {}, onRetryRuntimeSettings() {} };
  const markup = [
    composerMarkup({ ...base, autoCompactionEnabled: null, runtimeSettingsRead: { status: "loading" } }),
    composerMarkup({ ...base, autoCompactionEnabled: false, runtimeSettingsRead: { status: "ready" } }),
    composerMarkup({ ...base, autoCompactionEnabled: null, runtimeSettingsRead: { status: "error", error: "HTTP 500" } }),
  ];
  for (const [index, status] of ["loading", "ready", "error"].entries()) {
    const html = markup[index];
    const at = html.indexOf(`data-state="${status}"`);
    assert.ok(at > 0);
    const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at));
    assert.match(tag, /width:auto/);
    assert.doesNotMatch(tag, /width:168px/);
    assert.match(tag, /height:32px/);
    if (status === "loading") assert.match(tag, /\sdisabled=""/);
    else assert.doesNotMatch(tag, /\sdisabled=""/);
    if (status === "ready") assert.match(tag, /aria-pressed="false"/);
    if (status === "error") {
      assert.match(html, /Settings unavailable|设置读取失败/);
      assert.match(tag, /HTTP 500/);
      assert.doesNotMatch(tag, /aria-busy|aria-pressed/);
    }
  }
});

test("streaming model reasoning and Fast controls remain enabled until a configuration write", () => {
  const props = { isStreaming: true, model: { provider: "test", modelId: "gpt-test" }, modelList: [{ id: "gpt-test", name: "Test model", provider: "test" }], onModelChange() {}, onThinkingLevelChange() {}, fastMode: { supported: true, enabled: false, mode: "standard" }, onFastModeChange() {}, onToolPresetChange() {} };
  const html = composerMarkup(props);
  for (const labels of [["Change reasoning level", "更改推理级别"], ["Change Fast mode", "更改 Fast mode"]]) {
    const label = labels.find((value) => html.includes(`aria-label="${value}"`));
    assert.ok(label);
    const index = html.indexOf(`aria-label="${label}"`);
    assert.ok(index > 0);
    const tag = html.slice(html.lastIndexOf("<button", index), html.indexOf(">", index));
    assert.doesNotMatch(tag, /disabled/);
    const pending = composerMarkup({ ...props, runtimeSettingsUpdating: true });
    const pi = pending.indexOf(`aria-label="${label}"`);
    assert.match(pending.slice(pending.lastIndexOf("<button", pi), pending.indexOf(">", pi)), /disabled/);
  }
  assert.doesNotMatch(html, /aria-label="Change tool preset"/);
});

test("user draft injection focuses committed value and explicitly selects its final character", () => {
  const effect = chatInputSource.slice(chatInputSource.indexOf("    const pending = pendingDraftFocusRef.current;"), chatInputSource.indexOf("  useImperativeHandle(ref"));
  assert.match(effect, /pending.key !== draftKey \|\| pending.value !== value/);
  assert.match(effect, /ta.focus\(\)/);
  assert.match(effect, /ta.setSelectionRange\(ta.value.length, ta.value.length\)/);
  assert.match(effect, /resizeChatInput\(ta, true\)/);
});

test("keeps the final line visible when a max-height draft receives a newline", () => {
  assert.match(chatInputSource, /const CHAT_INPUT_MAX_HEIGHT = 200/);
  assert.match(chatInputSource, /function resizeChatInput\(textarea: HTMLTextAreaElement, keepCaretVisible = false\)/);
  assert.match(chatInputSource, /textarea\.style\.height = `\$\{Math\.min\(textarea\.scrollHeight, CHAT_INPUT_MAX_HEIGHT\)\}px`/);
  assert.match(chatInputSource, /if \(keepCaretVisible && textarea\.selectionStart === textarea\.value\.length\)\s*\{[\s\S]*?textarea\.scrollTop = textarea\.scrollHeight/);
  assert.match(chatInputSource, /resizeChatInput\(ta, ta\.selectionStart === ta\.value\.length\)/);
  assert.match(chatInputSource, /resizeChatInput\(currentTextarea, cursor >= currentTextarea\.value\.length\)/);
});

test("resets fieldset sizing so long queued text cannot widen the composer", () => {
  const fieldset = chatInputSource.match(/<fieldset\s+disabled=\{builtinCommandPending\}[\s\S]*?style=\{\{([\s\S]*?)\}\}\s*>/);
  assert.ok(fieldset, "the composer should use a fieldset wrapper");
  assert.match(fieldset[1], /boxSizing:\s*"border-box"/);
  assert.match(fieldset[1], /width:\s*"100%"/);
  assert.match(fieldset[1], /minWidth:\s*0/);
  assert.match(fieldset[1], /margin:\s*0/);
  assert.match(fieldset[1], /border:\s*0/);

  const content = chatInputSource.match(/<div style=\{\{ maxWidth: constrainWidth[\s\S]*?\}\}>/);
  assert.ok(content, "the composer content wrapper should be width constrained");
  assert.match(content[0], /width:\s*"100%"/);
  assert.match(content[0], /minWidth:\s*0/);
  assert.match(chatInputSource, /textOverflow:\s*"ellipsis", whiteSpace:\s*"nowrap"/);
});

test("auto-compaction draft preference survives typing and remount without messages", () => {
  const key = "auto-only-draft-test";
  clearDraft(key);
  setDraft(key, { value: "", images: [], autoCompactionEnabled: false });
  assert.equal(getDraft(key).autoCompactionEnabled, false);
  setDraft(key, { value: "next", images: [] });
  assert.equal(getDraft(key).autoCompactionEnabled, false);
  rekeyDraft(key, key + ":promoted");
  assert.equal(getDraft(key + ":promoted").autoCompactionEnabled, false);
  clearDraft(key + ":promoted");
});

test("custom prompt details expose an edit action and preserve prompt fields", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SlashCommandDetailsDialog, {
      command: {
        name: "越查越多，还是越修越错？",
        description: "简要用途",
        promptDescription: "原始描述",
        source: "customPrompt",
        promptId: "prompt-1",
        content: "检查并分析问题。",
        order: 0,
      },
      content: "检查并分析问题。",
      loading: false,
      error: null,
      onClose() {},
      dialogRef: React.createRef(),
    }),
  ));

  assert.match(html, /aria-label="Edit Prompt"/);
  assert.match(html, /检查并分析问题。/);
  assert.match(slashDetailsSurfaceSource, /method: "POST"/);
  assert.match(slashDetailsSurfaceSource, /id: prompt\.id/);
  assert.match(slashDetailsSurfaceSource, /CUSTOM_PROMPTS_CHANGED_EVENT/);
});

test("custom prompt editor closes cleanly or asks how to handle unsaved edits", () => {
  assert.match(slashDetailsSurfaceSource, /data-custom-prompt-editor/);
  assert.match(slashDetailsSurfaceSource, /event\.target === event\.currentTarget\) requestClose\(\)/);
  assert.match(slashDetailsSurfaceSource, /const hasChanges = formTitle !== initialValue\.title[\s\S]*formContent !== initialValue\.content/);
  assert.match(slashDetailsSurfaceSource, /if \(hasChanges\) setConfirmClose\(true\);\s*else onClose\(\)/);
  assert.match(slashDetailsSurfaceSource, /settings\.continueEditing/);
  assert.match(slashDetailsSurfaceSource, /settings\.discardAndClose/);
  assert.match(slashDetailsSurfaceSource, /settings\.saveAndClose/);
});

test("opens slash command details as an independent modal, not an inserted card", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SlashCommandDetailsDialog, {
        command: { name: "honcho:sync", description: "sync", source: "extension", sourceInfo: { path: "/x/y.md" } },
        content: "Clear cached long-term memory",
        loading: false,
        error: null,
        onClose() {},
        dialogRef: React.createRef(),
      }),
    ),
  );

  // A real overlay with its own close button and modal semantics.
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /position:fixed/);
  assert.match(html, /Clear cached long-term memory/);
  assert.match(html, /\/x\/y\.md/);
  assert.doesNotMatch(html, /aria-label="Edit Prompt"/);
  // Escape is owned by the modal in the capture phase, so it cannot reach the
  // global handler that stops a running agent.
  assert.match(slashDetailsSurfaceSource, /window\.addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(slashDetailsSurfaceSource, /event\.stopPropagation\(\)/);
  assert.match(slashDetailsSurfaceSource, /tabIndex=\{-1\}/);
  assert.match(slashDetailsSurfaceSource, /createPortal\(surface, document\.body\)/);
  assert.match(chatInputSource, /slashDetailCommand && !embeddedInParent/);
  // The command list itself no longer carries the details body.
  const listBody = chatInputSource.slice(
    chatInputSource.indexOf('flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10'),
    chatInputSource.indexOf("{!slashCommandsLoading && displayedSlashCommands.length === 0 ? ("),
  );
  assert.doesNotMatch(listBody, /slashDetailContent/);
});

test("lets the host drop a centered composer when an upward menu opens", () => {
  assert.match(chatInputSource, /onUpwardMenuOpenChange\?\.\(upwardMenuOpen\)/);
  assert.match(chatInputSource, /const upwardMenuOpen = slashMenuOpen \|\| atMenuOpen \|\| historyMenuOpen;/);
  const chatWindowSource = chatWindowSourceForTest;
  assert.match(chatWindowSource, /onUpwardMenuOpenChange=\{setComposerMenuOpen\}/);
  assert.match(chatWindowSource, /composerMenuOpen \? "justify-end pb-4 pt-2" : "justify-center py-8"/);
});

test("only the chat composer offers saving a default model or reasoning level", () => {
  const chatInputSource = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const agentsConfigSource = readFileSync(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
  assert.match(chatInputSource, /<SelectorRow[\s\S]*?isDefault: defaultModel\?\.provider === opt\.provider[\s\S]*?onSetDefaultModel\(opt\.provider, opt\.modelId\)/);
  // "auto" means "use the default", so it never gets a star of its own.
  assert.match(chatInputSource, /star=\{onSetDefaultThinkingLevel && lvl !== "auto"/);
  // A subagent profile's model is not the default for new chats.
  assert.doesNotMatch(agentsConfigSource, /onSetDefault/);
});

test("selector rows keep the default star and the floating save button in one gutter", async () => {
  const { SelectorRow } = await jiti.import("./SelectorRow.tsx");
  const star = (isDefault) => ({ isDefault, saveLabel: "Save as default", defaultLabel: "Default", onSave: () => {} });
  const row = (props) => renderToStaticMarkup(React.createElement(SelectorRow, {
    active: false,
    onSelect: () => {},
    ...props,
  }, "Alpha"));

  const savable = row({ star: star(false) });
  assert.match(savable, /role="option"/);
  assert.match(savable, /aria-label="Save as default"/);
  // Hidden until hover or focus, but kept out of the row's text by the gutter.
  assert.match(savable, /opacity:0/);
  assert.match(savable, /tabindex="-1"/);
  assert.match(savable, /padding:7px 36px 7px 12px/);
  assert.doesNotMatch(savable, /aria-label="Default"/);

  // The default row shows a static marker in the same spot and no button.
  const saved = row({ star: star(true) });
  assert.match(saved, /role="img" aria-label="Default"/);
  assert.match(saved, /fill="currentColor"/);
  assert.doesNotMatch(saved, /Save as default/);

  const plain = row({});
  assert.doesNotMatch(plain, /Save as default|aria-label="Default"/);
  assert.match(plain, /padding:7px 12px/);
  // Rows without a star still line up with starred ones in the same menu.
  assert.match(row({ gutter: true }), /padding:7px 36px 7px 12px/);

  const active = row({ active: true });
  assert.match(active, /aria-selected="true"/);
  assert.doesNotMatch(active, /border-left/);
});


test("renders slash detail Markdown safely with remote file-image context", () => {
  // The detail surface must be owned by the document-level modal host so an
  // embedded Reader cannot trap the backdrop inside the right-hand iframe.
  assert.match(slashDetailsSurfaceSource, /createPortal\(surface, document\.body\)/);
  assert.match(slashDetailsSurfaceSource, /position: "fixed"/);
  assert.match(slashDetailsSurfaceSource, /data-slash-command-details-backdrop/);
  const content = "# Review\n\n- [docs](https://example.com/docs)\n\n```ts\nconst value = 1;\n```\n\n<details><summary>More</summary>Extra detail</details>\n\n![result](/safe/result.png)\n\n<script>alert(1)</script>\n[unsafe](javascript:alert(1))";
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SlashCommandDetailsDialog, {
      command: { name: "review", source: "extension", sourceInfo: { path: "/safe/review.md" } },
      content, loading: false, error: null, onClose() {}, dialogRef: React.createRef(),
      cwd: "/safe", sessionId: "synthetic-detail-session", remotePeer: "synthetic-peer",
    })));
  assert.match(html, /<h1 data-heading-anchor="review"[^>]*>Review<\/h1>/);
  assert.match(html, /<li><a [^>]*href="https:\/\/example\.com\/docs"/);
  assert.match(html, /markdown-code-block/);
  assert.match(html, /<details><summary>More<\/summary>/);
  assert.match(html, /\/safe\/review\.md/);
  assert.match(html, /synthetic-peer/);
  assert.match(html, /synthetic-detail-session/);
  assert.doesNotMatch(html, /<script|javascript:/);
});

test('a pending built-in runs once and never clears a newer draft or new attachment', async () => {
  let resolve;
  let calls = 0, clears = 0;
  const context = {
    attachedImagesRef: { current: [] },
    valueRef: { current: '/mcp' },
    builtinCommandPendingRef: { current: false },
    setBuiltinCommandPending() {},
    canClearBuiltinCommandInput: canClearBuiltinCommandInput,
    clearInput() { clears++; },
    onBuiltinCommand() { calls++; return new Promise(r => { resolve = r; }); },
  };
  const run = chatInputCallback('runBuiltinCommand', context);
  const first = run('/mcp');
  assert.equal(await run('/mcp'), true);
  assert.equal(calls, 1);
  context.valueRef.current = 'edited during response';
  resolve({ handled: true });
  assert.equal(await first, true);
  assert.equal(clears, 0);
  assert.equal(context.builtinCommandPendingRef.current, false);
  context.valueRef.current = '/mcp';
  const second = run('/mcp');
  context.attachedImagesRef.current = [{}];
  resolve({ handled: true });
  await second;
  assert.equal(clears, 0);
  assert.equal(await run('/mcp'), false);
});

test('built-in RPC errors keep the draft and release the pending lock', async () => {
  let clears = 0;
  const context = {
    attachedImagesRef: { current: [] }, valueRef: { current: '/session' },
    builtinCommandPendingRef: { current: false }, setBuiltinCommandPending() {},
    canClearBuiltinCommandInput: canClearBuiltinCommandInput,
    clearInput() { clears++; }, onBuiltinCommand: async () => { throw new Error('synthetic RPC failure'); },
  };
  const run = chatInputCallback('runBuiltinCommand', context);
  await assert.rejects(run('/session'), /synthetic RPC failure/);
  assert.equal(context.builtinCommandPendingRef.current, false);
  assert.equal(clears, 0);
});

test('native list continuation ends an empty item and ignores IME confirmations', () => {
  let prevented = 0;
  const commands = [];
  const ta = { value: '- first\n- ', selectionStart: 10, selectionEnd: 10, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const handler = chatInputCallback('continueList', {
    ta, getMarkdownListEdit,
    document: { execCommand(...args) { commands.push(args); } },
  });
  handler({ inputType: 'insertLineBreak', isComposing: true, preventDefault() { prevented++; } });
  assert.equal(commands.length, 0);
  handler({ inputType: 'insertLineBreak', isComposing: false, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(ta.selectionStart, 8);
  assert.equal(ta.selectionEnd, 10);
  assert.deepEqual(commands, [['delete', false, '']]);
});

test('explicit newline and Shift Enter use the full edit range for list termination', () => {
  const ta = { value: '1. first\n2. ', selectionStart: 12, selectionEnd: 12 };
  let next, caret;
  const context = {
    textareaRef: { current: ta }, valueRef: { current: ta.value }, getMarkdownListEdit,
    insertAtSelection: insertAtSelection,
    setValue(value) { next = value; }, setSlashCaret(value) { caret = value; },
    setHistoryMenuOpen() {}, updateAtQuery() {}, requestAnimationFrame() {},
  };
  chatInputCallback('insertNewline', context)();
  assert.equal(next, '1. first\n');
  assert.equal(caret, 9);
  ta.value = '```\n- code'; ta.selectionStart = ta.value.length; ta.selectionEnd = ta.value.length;
  chatInputCallback('insertNewline', context)();
  assert.equal(next, '```\n- code\n');
});

test('slash detail Escape preserves IME and gives an image modal its own Escape', () => {
  // The detail surface owns Escape in its capture listener. Keep the
  // assertions against the shared surface source so moving the modal out of
  // ChatInput cannot silently make the composer handler the owner again.
  assert.match(slashDetailsSurfaceSource, /event\.key !== "Escape" \|\| event\.defaultPrevented/);
  assert.match(slashDetailsSurfaceSource, /event\.stopPropagation\(\)/);
  assert.match(slashDetailsSurfaceSource, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(slashDetailsSurfaceSource, /data-image-preview-close-controls/);
  assert.match(slashDetailsSurfaceSource, /data-file-viewer-modal/);
  assert.match(fileViewerModalSource, /data-file-viewer-modal/);
  assert.match(slashDetailsSurfaceSource, /onClose\(\)/);
});


test("an unowned MCP command queues its captured message without clearing a newer draft", async () => {
  const images = [];
  let resolve, cleared = 0;
  const sent = [];
  const context = {
    value: "/mcp", attachedImages: images, quotes: [],
    valueRef: { current: "/mcp" }, attachedImagesRef: { current: images },
    quotesRef: { current: [] }, hasStreamingMessagePayload,
    onAudioUnlock() {}, onBuiltinCommand() {},
    canRunBuiltinSlashCommandWhileStreaming, isBareMcpCommand,
    runBuiltinCommand: () => new Promise(r => { resolve = r; }),
    clearInput() { cleared++; },
    onPromptWithStreamingBehavior: (...args) => sent.push(args),
    onSteer() {}, onFollowUp() {},
  };
  chatInputCallback("sendQueued", context)("steer");
  context.valueRef.current = "new draft";
  resolve(false);
  await new Promise(r => setImmediate(r));
  assert.equal(sent[0][0], "/mcp");
  assert.equal(sent[0][1], "steer");
  assert.equal(cleared, 0);
});

test("streaming queue controls count text, images, and selected quotes", () => {
  assert.equal(hasStreamingMessagePayload("", 0, 0), false);
  assert.equal(hasStreamingMessagePayload("continue", 0, 0), true);
  assert.equal(hasStreamingMessagePayload("", 1, 0), true);
  assert.equal(hasStreamingMessagePayload("", 0, 1), true);
});

test("queues selected conversation without typed text", () => {
  const quotes = [{ id: "quote-1" }];
  const images = [];
  let cleared = 0;
  let clearedQuotes;
  let sent;
  const context = {
    value: "", attachedImages: images, quotes,
    valueRef: { current: "" }, attachedImagesRef: { current: images }, quotesRef: { current: quotes },
    hasStreamingMessagePayload,
    onAudioUnlock() {},
    clearInput() { cleared++; },
    setQuotes(value) { clearedQuotes = value; },
    formatQuoteItemsToMarkdown(items, translate) {
      assert.deepEqual(items, quotes);
      assert.equal(translate, en);
      return "> selected conversation";
    },
    t: en,
    onBuiltinCommand: null,
    onPromptWithStreamingBehavior: null,
    onSteer(...args) { sent = args; },
    onFollowUp() {},
  };
  chatInputCallback("sendQueued", context)("steer");
  assert.deepEqual(sent, ["> selected conversation", undefined]);
  assert.equal(cleared, 1);
  assert.ok(Array.isArray(clearedQuotes));
  assert.deepEqual(Array.from(clearedQuotes), []);
});

test("queues a message with only an attached image", () => {
  const images = [{ data: "AQID", mimeType: "image/png" }];
  const quotes = [];
  let cleared = 0;
  let sent;
  const context = {
    value: "", attachedImages: images, quotes,
    valueRef: { current: "" }, attachedImagesRef: { current: images }, quotesRef: { current: quotes },
    hasStreamingMessagePayload,
    onAudioUnlock() {},
    clearInput() { cleared++; },
    onBuiltinCommand: null,
    onPromptWithStreamingBehavior: null,
    onSteer() { assert.fail("followup must not steer"); },
    onFollowUp(...args) { sent = args; },
  };
  chatInputCallback("sendQueued", context)("followup");
  assert.deepEqual(sent, ["", images]);
  assert.equal(cleared, 1);
});
