import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
import { markupText, testTranslator } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const en = testTranslator("en");
async function renderInEnglish(element) {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: "en" }, element));
}

test("exports SidekickDrawer component", async () => {
  const mod = await jiti.import("./SidekickDrawer.tsx");
  assert.ok(typeof mod.SidekickDrawer === "function", "SidekickDrawer must be a component function");
});

test("Sidekick uses the model catalog key and inherits the input thinking level until changed", async () => {
  const { getSidekickThinkingLevels, resolveSidekickThinkingLevel } = await jiti.import("./SidekickDrawer.tsx");
  assert.deepEqual(
    getSidekickThinkingLevels(
      { provider: "CPA GPT", modelId: "gpt-5.6-luna" },
      {
        "CPA GPT:gpt-5.6-luna": ["xhigh", "max"],
        "CPA GPT/gpt-5.6-luna": ["low"],
      },
    ),
    ["auto", "xhigh", "max"],
  );
  assert.deepEqual(getSidekickThinkingLevels(null, {}), ["auto", "off", "low", "medium", "high"]);
  assert.equal(resolveSidekickThinkingLevel("high", ["auto", "xhigh", "max"], "high"), "max");
  assert.equal(resolveSidekickThinkingLevel("high", ["auto", "xhigh", "max"], "max"), "max");
  assert.equal(resolveSidekickThinkingLevel(null, ["auto", "xhigh", "max"], "max"), "max");
  assert.equal(resolveSidekickThinkingLevel(null, ["auto", "xhigh", "max"], "auto"), "auto");
  assert.equal(resolveSidekickThinkingLevel("auto", ["auto", "xhigh", "max"], "max"), "auto");
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /const \[thinkingLevelOverride, setThinkingLevelOverride\] = useState<string \| null>\(null\)/);
  assert.match(source, /resolveSidekickThinkingLevel\(thinkingLevelOverride, availableThinkingLevelsList, defaultThinkingLevel \?\? "auto"\)/);
  assert.match(source, /\.\.\.\(requestedModel \? \{ model: requestedModel \} : \{\}\)/);
});

test("answers distinguish native truncation, missing body and thinking without guessing historical outcomes", async () => {
  const { createElement } = await import("react");
  const { SidekickAnswer } = await jiti.import("./SidekickDrawer.tsx");
  const render = (answer, thinking, stopReason) => renderInEnglish(createElement(SidekickAnswer, {
    entry: { stopReason, data: { answer, thinking } },
  }));
  const truncated = markupText(en("sidekick.outputLimitReached"));
  const noBody = markupText(en("sidekick.noAnswerBody"));
  const thinkingLabel = markupText(en("sidekick.thinkingBlock", { thinking: "" }).match(/\*\*(.+?)\*\*/)[1]);
  const partial = await render("partial answer", "thinking", "length");
  assert.ok(partial.includes("partial answer"));
  assert.ok(partial.includes(truncated));
  assert.match(partial, /role="status"/);
  assert.ok(!partial.includes(noBody));
  const thinkingOnly = await render("", "kept thinking", "length");
  assert.ok(thinkingOnly.includes(truncated));
  assert.ok(thinkingOnly.includes(noBody));
  assert.ok(thinkingOnly.includes(thinkingLabel));
  assert.ok(thinkingOnly.includes("kept thinking"));
  const empty = await render("  ", "", "stop");
  assert.ok(empty.includes(noBody));
  assert.ok(!empty.includes(truncated) && !empty.includes(thinkingLabel));
  for (const reason of ["stop", undefined]) {
    const normal = await render("complete answer", "", reason);
    assert.ok(normal.includes("complete answer"));
    assert.ok(!normal.includes(truncated) && !normal.includes(noBody));
    assert.doesNotMatch(normal, /role="status"/);
  }
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /<SidekickAnswer entry=\{item\} \/>/);
});

test("streaming and saved questions share the transcript font scale and copy/quote controls", async () => {
  const { createElement } = await import("react");
  const { SidekickQuestion } = await jiti.import("./SidekickDrawer.tsx");
  const html = await renderInEnglish(createElement(SidekickQuestion, { question: "question", images: [], copied: false, onCopy() {}, onQuote() {} }));
  assert.match(html, /font-size:var\(--chat-content-font-size, 14px\)/);
  assert.match(html, /line-height:1.7/);
  assert.ok(html.includes(`aria-label="${markupText(en("sidekick.copyQuestion"))}"`));
  assert.ok(html.includes(`aria-label="${markupText(en("sidekick.quoteQuestion"))}"`));
  const literal = await renderInEnglish(createElement(SidekickQuestion, { question: '<div style="display:none">visible</div>', images: [], copied: false, onCopy() {} }));
  assert.match(literal, /&lt;div style=/);
  assert.match(literal, /visible/);
  assert.doesNotMatch(literal, /<div style="display:none"/);
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<SidekickQuestion /g) ?? []).length, 2);
});

test("one compact header contains accessible thread tabs and independent background activity", async () => {
  const { createElement } = await import("react");
  const { SidekickHeader } = await jiti.import("./SidekickDrawer.tsx");
  const html = await renderInEnglish(createElement(SidekickHeader, { threads: [{ id: "default", label: "1", count: 10 }, { id: "other", label: "2", count: 0 }], activeThreadId: "default", busyThreads: new Set(["other"]), mainBusy: true, expanded: false, rightPanel: false, canFork: true, isForking: false, onSelect() {}, onCloseThread() {}, onDelete() {}, onCreate() {}, onFork() {}, onExpand() {}, onClose() {} }));
  assert.equal((html.match(/data-sidekick-header/g) ?? []).length, 1);
  assert.match(html, /min-height:36px/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  assert.match(html, /class="sidekick-stream-label"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.ok(html.includes(`aria-label="${markupText(en("sidekick.closeThread", { label: "1" }))}"`));
  assert.doesNotMatch(html, /sidekick-stream-dot|> ●</);
  assert.ok(html.includes(`aria-label="${markupText(en("sidekick.fork"))}"`));
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>).)*<button/s);
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /onContextMenu=\{\(event\) => openContextMenu\(event, thread\.id\)\}/);
  assert.match(source, /data-sidekick-context-menu="true"/);
  assert.match(source, /t\("sidekick\.deleteThreadForever"\)/);
  assert.match(source, /onCloseThread=\{handleCloseThread\}/);
  assert.doesNotMatch(source, /Context rule info bar|Tip bar:|100% 命中/);
});

test("does not recreate the deleted default thread when hydrating history", async () => {
  const { mergeSidekickThreadLists, sidekickViewKey } = await jiti.import("./SidekickDrawer.tsx");
  assert.equal(typeof mergeSidekickThreadLists, "function");
  const url = "/api/sessions/session/quick-ask";
  const listKey = sidekickViewKey(url, "main", "");
  const hydrated = mergeSidekickThreadLists({}, url, [{ data: { branchId: "main", threadId: "second" } }]);
  assert.deepEqual(hydrated[listKey], ["second"]);
  const withLocalTabs = mergeSidekickThreadLists({ [listKey]: ["default", "draft"] }, url, [{ data: { branchId: "main", threadId: "second" } }]);
  assert.deepEqual(withLocalTabs[listKey], ["default", "draft", "second"]);
});

test("after the default topic is deleted, the hydrated drawer selects a listed topic", async () => {
  const { resolveSidekickActiveThread } = await jiti.import("./SidekickDrawer.tsx");
  assert.equal(resolveSidekickActiveThread(undefined, ["second", "third"]), "second");
  assert.equal(resolveSidekickActiveThread("gone", ["second"]), "second");
  // Existing selections and the listed default topic keep their current behavior.
  assert.equal(resolveSidekickActiveThread("third", ["second", "third"]), "third");
  assert.equal(resolveSidekickActiveThread(undefined, ["second", "default"]), "default");
  assert.equal(resolveSidekickActiveThread(undefined, ["default"]), "default");
});

test("uses matching lucide icons and dismisses on outside pointer", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /Maximize2 size=\{14\} strokeWidth=\{1\.8\}/);
  assert.match(source, /Minimize2 size=\{14\} strokeWidth=\{1\.8\}/);
  assert.match(source, /<X size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/>/);
  assert.match(source, /width: 24/);
  assert.match(source, /height: 24/);
  assert.match(source, /border: "1px solid var\(--border\)"/);
  assert.doesNotMatch(source, /<span aria-hidden="true">✕<\/span>/);
  assert.match(source, /const drawerRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /ownerDocument\.addEventListener\("pointerdown", handleOutsidePointerDown\)/);
  assert.match(source, /if \(!open \|\| isRightPanelPlacement\) return;/);
  assert.match(source, /\[expanded, isRightPanelPlacement, onClose, open\]/);
  assert.match(source, /closest\("\[data-sidekick-interaction\]"\)/);
  assert.match(source, /drawerRef\.current\?\.contains\(target as Node\)/);
  assert.match(source, /ref=\{drawerRef\}/);
  assert.match(source, /data-sidekick-drawer="true"/);
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShellSource, /data-sidekick-interaction=\{sidekickInteraction \? "true" : undefined\}/);
  assert.match(appShellSource, /data-sidekick-drawer/);
  assert.match(appShellSource, /EMBEDDED_SIDEKICK_DISMISS_EVENT/);
  assert.match(appShellSource, /document\.addEventListener\("pointerdown", handleEmbeddedParentPointerDown\)/);
  assert.match(appShellSource, /iframe\.contentWindow\?\.postMessage\(\{ type: EMBEDDED_SIDEKICK_DISMISS_EVENT \}/);
  assert.match(source, /event\.source !== window\.parent/);
  assert.match(source, /window\.addEventListener\("message", handleEmbeddedParentDismiss\)/);
  assert.match(source, /data\?\.type !== EMBEDDED_SIDEKICK_DISMISS_EVENT/);
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindowSource, /data-sidekick-interaction="true"/);
  assert.match(chatWindowSource, /onClick=\{actions\.askSidekick\}/);
});

test("sidekick composer keeps IME confirmation Enter out of submit", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /handleExtensionDialogInputKeyDown/);
  assert.match(source, /getExtensionDialogInputCompositionEndAtOnBlur/);
  assert.match(source, /const questionCompositionActiveRef = useRef\(false\)/);
  assert.match(source, /const questionCompositionEndAtRef = useRef\(0\)/);
  const textareaStart = source.indexOf("<textarea");
  const textareaEnd = source.indexOf("/>", textareaStart);
  assert.ok(textareaStart >= 0 && textareaEnd > textareaStart, "sidekick textarea must exist");
  const textarea = source.slice(textareaStart, textareaEnd);
  assert.match(textarea, /handleExtensionDialogInputKeyDown\(\s*e\.nativeEvent,/);
  assert.match(textarea, /onCompositionStart=\{\(\) => \{/);
  assert.match(textarea, /onCompositionEnd=\{\(\) => \{/);
});

test("keeps sidekick composer wrapped without horizontal overflow", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const textareaStart = source.indexOf("<textarea");
  const textareaEnd = source.indexOf("/>", textareaStart);
  assert.ok(textareaStart >= 0 && textareaEnd > textareaStart, "sidekick textarea must exist");
  const textarea = source.slice(textareaStart, textareaEnd);
  assert.match(textarea, /wrap=\"soft\"/);
  assert.match(textarea, /minWidth: 0/);
  assert.match(textarea, /overflowX: \"hidden\"/);
  assert.match(textarea, /overflowWrap: \"anywhere\"/);
  assert.match(textarea, /whiteSpace: \"pre-wrap\"/);
});

test("parent-page dismissal applies to the session overlay, not the docked tab", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const listenerStart = source.indexOf("const handleEmbeddedParentDismiss");
  const effectStart = source.lastIndexOf("useEffect(() => {", listenerStart);
  const effectEnd = source.indexOf("\n  useEffect", listenerStart);
  assert.ok(effectStart >= 0 && effectEnd > listenerStart);
  const effect = source.slice(effectStart, effectEnd);
  assert.match(effect, /if \(!open \|\| isRightPanelPlacement \|\| typeof window === "undefined" \|\| window\.parent === window\) return;/);
  assert.match(effect, /\[isRightPanelPlacement, onClose, open\]/);
  assert.match(effect, /event\.source !== window\.parent/);
  assert.match(effect, /data\?\.type !== EMBEDDED_SIDEKICK_DISMISS_EVENT/);
  assert.match(effect, /onClose\(\)/);
  assert.match(effect, /window\.removeEventListener\("message", handleEmbeddedParentDismiss\)/);

  // Execute the production subscription effect with a fake parent-window
  // channel so the regression covers dismissal behavior and cleanup.
  const { transpileModule } = await jiti.import("typescript");
  const compiled = transpileModule(effect, {}).outputText;
  const parent = {};
  let listener;
  let closeCount = 0;
  const ownerWindow = {
    parent,
    addEventListener(type, callback) {
      assert.equal(type, "message");
      listener = callback;
    },
    removeEventListener(type, callback) {
      assert.equal(type, "message");
      assert.equal(callback, listener);
      listener = undefined;
    },
  };
  const subscribe = new Function("useEffect", "window", "open", "isRightPanelPlacement", "onClose", "EMBEDDED_SIDEKICK_DISMISS_EVENT", compiled);
  let cleanup;
  const runEffect = (docked) => subscribe((callback) => { cleanup = callback(); }, ownerWindow, true, docked, () => { closeCount += 1; }, "parent-dismiss");
  runEffect(true);
  assert.equal(listener, undefined, "docked tab must not subscribe to parent-page dismissal");
  assert.equal(closeCount, 0);
  runEffect(false);
  assert.equal(typeof listener, "function");
  listener({ source: {}, data: { type: "parent-dismiss" } });
  listener({ source: parent, data: { type: "other-message" } });
  assert.equal(closeCount, 0, "unrelated messages must not close the session overlay");
  listener({ source: parent, data: { type: "parent-dismiss" } });
  assert.equal(closeCount, 1, "parent-page dismissal must still close the session overlay");
  cleanup();
  runEffect(true);
  assert.equal(listener, undefined, "switching to the docked tab must remove the overlay listener");
});

test("Sidekick composer stays inside drawer while growing upward", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /const resizeQuestion = useCallback/);
  assert.match(source, /const restoreQuestionView = useCallback/);
  assert.match(source, /restoreQuestionView\(\)/);
  assert.match(source, /textarea\.setSelectionRange\(len, len\)/);
  assert.match(source, /textarea\.scrollTop = textarea\.scrollHeight/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => textareaRef\.current\?\.focus\(\), 150\)/);
  assert.match(source, /window\.innerHeight \* 0\.5/);
  assert.match(source, /drawerRef\.current\?\.clientHeight/);
  assert.match(source, /Math\.floor\(drawerHeight \* (?:0\.35|0\.4)\)/);
  assert.match(source, /textarea\.scrollHeight > maxHeight/);
  assert.match(source, /maxHeight: isRightPanelPlacement \? "min\(55%, 70dvh\)" : "min\(40%, 50dvh\)"/);
  assert.match(source, /flex: "1 1 auto",[\s\S]*minHeight: (?:0|56)[\s\S]*maxHeight: "100%"/);
  assert.match(source, /display: "flex",[\s\S]*flexDirection: "column",[\s\S]*flex: "(?:0|1) 1 auto",[\s\S]*maxHeight: isRightPanelPlacement \? "min\(55%, 70dvh\)" : "min\(40%, 50dvh\)"/);
  assert.match(source, /flex: "1 1 auto",[\s\S]*minHeight: (?:0|64)[\s\S]*overflow: "hidden"/);
  assert.match(source, /onInput=\{resizeQuestion\}/);
});

test("Sidekick composer accepts, previews, and submits image attachments", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /onPaste=\{handlePaste\}/);
  assert.match(source, /accept="image\/\*"/);
  assert.match(source, /compressImageFile/);
  assert.match(source, /<ImageAttachments images=\{attachedImages\} onRemove=\{removeImage\} \/>/);
  assert.match(source, /images: submittedImages\.map/);
  assert.match(source, /const itemImages = .*item\.data\.images/);
  assert.match(source, /<ImagePreview/);
});

test("Sidekick expanded view uses a centered full-screen modal", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(source, /createPortal\(/);
  assert.match(source, /function sidekickPortalDocument\(\)/);
  assert.match(source, /window\.parent\.document/);
  assert.match(source, /portalDocument\.body/);
  assert.match(source, /notifyEmbeddedModalState\(true, "sidekick"\)/);
  assert.match(source, /aria-modal=\{expanded \? true : undefined\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => setExpanded\(false\)\}/);
  assert.doesNotMatch(source, /role="presentation"[\s\S]*onClick=\{onClose\}/);
  assert.match(source, /event\.key !== "Escape"/);
  assert.match(source, /onClick=\{onClose\}/);
  assert.match(source, /position: "relative",\s*width: "min\(1120px, calc\(100vw - 28px\)\)"/);
  assert.match(source, /height: "min\(88vh, calc\(100dvh - 36px\)\)"/);
  assert.match(source, /role="presentation"[\s\S]*position: "fixed"[\s\S]*inset: 0/);
  assert.match(source, /display: "flex",\s*alignItems: "center",\s*justifyContent: "center"/);
  assert.match(source, /backdropFilter: "blur\(2px\)"/);
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShellSource, /data\.kind === "sidekick"/);
  assert.match(appShellSource, /embeddedModalKind === "sidekick"[\s\S]*position: "fixed"/);
});

test("ChatWindow integrates SidekickDrawer with shell-controlled state", async () => {
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindowSource, /import\s*\{[\s\S]*?SidekickDrawer/);
  assert.match(chatWindowSource, /<SidekickDrawer/);
  assert.match(chatWindowSource, /sidekickOpen\?: boolean/);
  assert.match(chatWindowSource, /open=\{sidekickIsOpen \|\| sidekickRightPanelIsOpen\}/);
  assert.match(chatWindowSource, /placement=\{sidekickRightPanelIsOpen \? "right-panel" : "sidebar"\}/);
  assert.match(chatWindowSource, /rightPanelTargetId=\{SIDEKICK_RIGHT_PANEL_TARGET_ID\}/);
  assert.match(chatWindowSource, /onClose=\{closeSidekick\}/);
  assert.doesNotMatch(chatWindowSource, /SessionBranchTabs/);
});

test("offers the shared sidekick view inside the resizable right panel", async () => {
  const sidekickSource = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(sidekickSource, /SIDEKICK_RIGHT_PANEL_TARGET_ID = "reader-right-panel-sidekick"/);
  assert.match(sidekickSource, /placement\?: "sidebar" \| "right-panel"/);
  assert.match(sidekickSource, /if \(isRightPanelPlacement\) \{[\s\S]*document\.getElementById\(rightPanelTargetId\)/);
  assert.match(sidekickSource, /position: "relative",[\s\S]*width: "100%",[\s\S]*height: "100%"/);
  assert.match(appShellSource, /data-right-panel-sidekick-toggle="true"/);
  assert.match(appShellSource, /const toggleSidekickRightPanel = useCallback/);
  assert.match(appShellSource, /id=\{SIDEKICK_RIGHT_PANEL_TARGET_ID\}/);
  assert.match(appShellSource, /display: isSidekickTabActive \? "none" : "block"/);
  assert.match(appShellSource, /SIDEKICK_TAB_ID/);
  assert.doesNotMatch(appShellSource, /if \(!rightPanelOpen\) setSidekickRightPanelOpen\(false\);/);
  const toggleStart = appShellSource.indexOf('data-right-panel-sidekick-toggle="true"');
  const toggleEnd = appShellSource.indexOf('data-terminal-open="true"', toggleStart);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart, "right-panel sidekick toggle must be present");
  const toggle = appShellSource.slice(toggleStart, toggleEnd);
  assert.match(toggle, /width: TOP_BAR_ICON_BUTTON_SIZE/);
  assert.match(toggle, /padding: 0/);
  assert.doesNotMatch(toggle, /<span>\{translate\("sidekick\.title"\)\}<\/span>/);
});

test("routes Sidekick forks through the shell-owned session transition", async () => {
  const sidekickSource = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(sidekickSource, /onSessionForked\?: \(result: SessionForkResult\) => void/);
  assert.match(sidekickSource, /if \(onSessionForked\) \{[\s\S]*onSessionForked\(\{ newSessionId: data\.newSessionId, newSessionPath: data\.newSessionPath, subprojectAssignmentFailed: data\.subprojectAssignmentFailed \}\);[\s\S]*return;/);
  assert.doesNotMatch(sidekickSource, /window\.location\.(href|assign)\s*=/);
  assert.match(sidekickSource, /router\.replace\(`\$\{window\.location\.pathname\}/);
  assert.match(chatWindowSource, /onSessionForked=\{onSessionForked\}/);
  assert.match(appShellSource, /setRefreshKey\(\(k\) => k \+ 1\)/);
  assert.match(appShellSource, /setSelectedSession\(\(prev\) => \(/);
  assert.match(appShellSource, /hydrateSelectedSession\(newSessionId\)/);
  assert.match(appShellSource, /router\.replace\(`\?\$\{params\.toString\(\)\}`, \{ scroll: false \}\)/);
});

test("AppShell places sidekick control in the session top bar", async () => {
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShellSource, /MessageSquare/);
  assert.match(appShellSource, /onClick=\{toggleSidekick\}/);
  assert.match(appShellSource, /translate\(\"sidekick\.title\"\)/);
});

test("renders the Sidekick message icon with minimap fill and no center number", async () => {
  const sidekickSource = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const minimapSource = await readFile(new URL("./ChatMinimap.tsx", import.meta.url), "utf8");
  const iconSource = appShellSource.match(/function SidekickMessageIcon[\s\S]*?\n}\n/)?.[0];
  assert.ok(iconSource, "SidekickMessageIcon must exist");
  assert.match(sidekickSource, /onCountChange\?: \(count: number\) => void/);
  assert.match(sidekickSource, /const hasSidekickContent = branchItems\.length > 0/);
  assert.match(sidekickSource, /const sidekickTagCount = hasSidekickContent \? threadList\.length : 0/);
  assert.match(sidekickSource, /onCountChange\?\.\(sidekickTagCount\)/);
  assert.match(chatWindowSource, /onSidekickCountChange\?: \(count: number\) => void/);
  assert.match(chatWindowSource, /onCountChange=\{onSidekickCountChange\}/);
  assert.match(iconSource, /strokeWidth=\{1\.8\}/);
  const minimapFill = 'color-mix(in srgb, var(--accent) 55%, transparent)';
  assert.ok(minimapSource.includes(`node.kind === "compaction" ? "${minimapFill}"`));
  assert.ok(iconSource.includes(`fill={count > 0 ? "${minimapFill}" : "none"}`));
  assert.match(iconSource, /color="currentColor"/);
  assert.doesNotMatch(iconSource, /#9ca3af|#2563eb|fontSize|count > 0 &&/);
  assert.match(appShellSource, /<SidekickMessageIcon count=\{sidekickCount\} \/>/);
  assert.match(appShellSource, /const sidekickButtonLabel = `\$\{translate\("sidekick\.title"\)\}/);
  assert.match(appShellSource, /sidekickCount > 0/);
});

test("sends the active branch and parent when asking from Sidekick", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const sendHandler = source.match(/const handleSend = async \([\s\S]*?\n  \};/)?.[0];
  assert.ok(sendHandler, "Sidekick send handler must exist");
  assert.match(sendHandler, /branchId: sideAskBranchId \|\| "main"/);
  assert.match(sendHandler, /\.\.\.\(activeParentId === undefined \? \{\} : \{ expectedParentId: activeParentId \}\)/);
  assert.doesNotMatch(sendHandler, /expectedParentId: activeParentId,\s*history/);
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindowSource, /activeParentId=\{sidekickParentId\}/);
});

test("does not treat the initial null parent as an explicit root during hydration", async () => {
  const sidekickSource = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(sidekickSource, /activeParentId === undefined \? \{\} : \{ expectedParentId: activeParentId \}/);
  assert.match(chatWindowSource, /const sidekickParentId = loading \|\| sessionStatePending \? undefined : activeLeafId;/);
  assert.match(chatWindowSource, /activeParentId=\{sidekickParentId\}/);
});

test("sends the active main-session branch when forking a Sidekick thread", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const forkHandler = source.match(/const handleForkToSession = async \([\s\S]*?\n  \};/)?.[0];
  assert.ok(forkHandler, "Sidekick fork handler must exist");
  assert.match(forkHandler, /branchId: sideAskBranchId \|\| "main"/);
});

test("moves selection actions into session top bar while preserving fallback", async () => {
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chatWindowSource, /onSelectionToolbarChange\?: \(actions: SelectionToolbarActions \| null\) => void/);
  assert.match(chatWindowSource, /!onSelectionToolbarChange && selectionTooltip/);
  assert.match(chatWindowSource, /onSelectionToolbarChange\(selectionTooltip \?/);
  assert.match(appShellSource, /const \[selectionToolbar, setSelectionToolbar\]/);
  assert.match(appShellSource, /onSelectionToolbarChange=\{topBarSessionId \? handleSelectionToolbarChange : undefined\}/);
  const topBarStart = appShellSource.indexOf("const sessionTopBar");
  const topBarEnd = appShellSource.indexOf("const chatWindowContent", topBarStart);
  const topBar = appShellSource.slice(topBarStart, topBarEnd);
  assert.match(topBar, /selectionToolbar \? \(/);
  assert.match(topBar, /<SessionTopBarButton[\s\S]*selectionToolbar\.askCurrent/);
  assert.match(topBar, /<SessionTopBarButton[\s\S]*selectionToolbar\.askSidekick/);
  assert.match(topBar, /<SessionTopBarButton[\s\S]*selectionToolbar\.dismiss/);
  assert.match(topBar, /<SessionTopBarButton[\s\S]*onClick=\{toggleSidekick\}/);
  assert.doesNotMatch(topBar, /role="toolbar"/);
});

test("reuses the session top-bar button for selection actions", async () => {
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const topBarStart = appShellSource.indexOf("const sessionTopBar");
  const topBarEnd = appShellSource.indexOf("const chatWindowContent", topBarStart);
  const topBar = appShellSource.slice(topBarStart, topBarEnd);
  assert.match(appShellSource, /function SessionTopBarButton/);
  assert.match(appShellSource, /height: 22/);
  assert.match(appShellSource, /boxSizing: "border-box"/);
  assert.doesNotMatch(topBar, /role="toolbar"/);
  assert.doesNotMatch(topBar, /boxShadow/);
  assert.doesNotMatch(topBar, /padding: "0 4px"/);
  assert.doesNotMatch(chatWindowSource, /topBar\?: boolean/);
});

test("i18n catalogs define all sidekick keys", async () => {
  const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
  const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
  for (const key of [
    "sidekick.title",
    "sidekick.subtitle",
    "sidekick.parallelReady",
    "sidekick.placeholder",
    "sidekick.emptyHistory",
    "sidekick.quoteToMain",
    "sidekick.copied",
    "sidekick.deleted",
    "sidekick.cacheHit",
    "sidekick.parallelTip",
  ]) {
    assert.ok(zhSource.includes(`"${key}":`), `zh-CN.ts must contain ${key}`);
    assert.ok(enSource.includes(`"${key}":`), `en.ts must contain ${key}`);
  }
});


test("scrolls to a newly mounted optimistic side question before its answer changes", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  useEffect(() => {\n    scrollToBottom();");
  const end = source.indexOf("\n\n  // Create new thread tab", start);
  assert.ok(start >= 0 && end > start, "sidekick scroll effect must exist");
  const effect = source.slice(start, end);
  assert.match(effect, /\[currentThreadItems, reply\?\.runId, streamingAnswer, scrollToBottom\]/);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function historyResponse(items, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ success: ok, items }),
  };
}

function makeDeferredFetcher() {
  const requests = [];
  const fetcher = (url, init = {}) => {
    const pending = deferred();
    requests.push({
      url: String(url),
      method: init.method || "GET",
      ...pending,
    });
    return pending.promise;
  };
  return { fetcher, requests };
}

function historyRef() {
  return {
    current: {
      requestId: 0,
      sessionId: "",
      quickAskUrl: "",
      promise: null,
      loaded: false,
    },
  };
}

test("drops a late GET when the session/URL identity changes", async () => {
  const { createSidekickHistoryController } = await jiti.import("./SidekickDrawer.tsx");
  const { fetcher, requests } = makeDeferredFetcher();
  const commits = [];
  const loadingTransitions = [];
  const controller = createSidekickHistoryController({
    historyRequestRef: historyRef(),
    fetcher,
    onItems: (items) => commits.push(items.map((item) => item.id)),
    onLoading: (loading) => loadingTransitions.push(loading),
  });

  const staleLoad = controller.load("old-session", "/old");
  const currentLoad = controller.load("new-session", "/new");
  assert.equal(requests.length, 2);

  requests[0].resolve(historyResponse([{ id: "old" }]));
  await staleLoad;
  assert.deepEqual(commits, []);

  requests[1].resolve(historyResponse([{ id: "new" }]));
  await currentLoad;
  assert.deepEqual(commits, [["new"]]);
  assert.deepEqual(loadingTransitions, [true, true, false]);
});

test("recovers durable count after an HTTP 500 DELETE", async () => {
  const { createSidekickHistoryController } = await jiti.import("./SidekickDrawer.tsx");
  const { fetcher, requests } = makeDeferredFetcher();
  const durableItem = { id: "durable", data: { question: "q", answer: "a" } };
  let shownItems = [];
  const reportedCounts = [];
  const controller = createSidekickHistoryController({
    historyRequestRef: historyRef(),
    fetcher,
    onItems: (items) => {
      shownItems = items;
      reportedCounts.push(shownItems.length);
    },
    onLoading() {},
  });

  const initialLoad = controller.load("session", "/quick-ask");
  requests[0].resolve(historyResponse([durableItem]));
  await initialLoad;
  assert.equal(shownItems.length, 1);

  const deletePromise = controller.deleteWithRecovery(
    "session",
    "/quick-ask",
    { targetId: durableItem.id },
    () => {
      shownItems = [];
      reportedCounts.push(shownItems.length);
    },
  );
  assert.equal(requests[1].method, "DELETE");
  requests[1].resolve(historyResponse([], false));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[2].method, "GET");

  requests[2].resolve(historyResponse([durableItem]));
  await deletePromise;
  assert.equal(shownItems.length, 1);
  assert.deepEqual(reportedCounts, [1, 0, 1]);
});

test("reports a cold durable count while the drawer is closed", async () => {
  const { createSidekickHistoryController } = await jiti.import("./SidekickDrawer.tsx");
  const { fetcher, requests } = makeDeferredFetcher();
  const reportedCounts = [];
  const drawerOpen = false;
  const controller = createSidekickHistoryController({
    historyRequestRef: historyRef(),
    fetcher,
    onItems: (items) => reportedCounts.push(items.length),
    onLoading() {},
  });

  const coldLoad = controller.load("session", "/quick-ask");
  const openLoad = controller.load("session", "/quick-ask");
  assert.equal(openLoad, coldLoad);
  assert.equal(drawerOpen, false);
  assert.equal(requests.length, 1);
  requests[0].resolve(historyResponse([
    { id: "one", data: { question: "q1", answer: "a1" } },
    { id: "two", data: { question: "q2", answer: "a2" } },
  ]));
  await coldLoad;
  assert.deepEqual(reportedCounts, [2]);
});


test("reports zero until side-question content exists, then counts topic tabs", async () => {
  const source = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(source, /const hasSidekickContent = branchItems\.length > 0 \|\| threadList\.some/);
  assert.match(source, /const sidekickTagCount = hasSidekickContent \? threadList\.length : 0/);
  assert.match(source, /onCountChange\?\.\(sidekickTagCount\)/);
});

test("portals sidekick header into session top bar with unified toolbar style and aligned controls", async () => {
  const sidekickSource = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  // Portal target exported and used by both components
  assert.match(sidekickSource, /export const SIDEKICK_TOPBAR_PORTAL_ID = "reader-session-topbar-sidekick"/);
  assert.match(appShellSource, /import\s*\{[^}]*SIDEKICK_TOPBAR_PORTAL_ID[^}]*\}\s*from "\.\/SidekickDrawer"/);
  assert.match(appShellSource, /id=\{SIDEKICK_TOPBAR_PORTAL_ID\}/);

  // Unopened state: shows only sidekick button with borderless clean style (100% height, width 36)
  assert.match(appShellSource, /\{!sidekickOpen && \(\s*<SessionTopBarButton[\s\S]*onClick=\{toggleSidekick\}[\s\S]*borderless/);
  assert.match(appShellSource, /height: borderless \? "100%" : 22/);
  assert.match(appShellSource, /background: borderless \? "transparent"/);

  // Opened state: SidekickDrawer portals Header to top bar, drawer body skips duplicate header
  assert.match(sidekickSource, /const shouldPortalToTopbar = isSidebarPlacement && !expanded/);
  assert.match(sidekickSource, /createPortal\(headerElement, topbarTarget\)/);
  assert.match(sidekickSource, /\{!isPortaled && headerElement\}/);

  // Top-bar buttons don't have dividing grid borders, and header always provides close button
  assert.match(sidekickSource, /const sidekickCloseButtonStyle: React\.CSSProperties = \{[\s\S]*width: 36/);
  assert.match(sidekickSource, /<X size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/>/);
  assert.match(sidekickSource, /aria-label=\{t\("sidekick\.close"\)\}/);

  // Bottom action bar contains model selector and thinking level selector with ChatInput display logic
  assert.match(sidekickSource, /modelDropdownOpen/);
  assert.match(sidekickSource, /thinkingDropdownOpen/);
  assert.match(sidekickSource, /selectedModel/);
  assert.match(sidekickSource, /selectedThinkingLevel/);
  assert.match(sidekickSource, /compareSidekickModelOptions/);
  assert.match(sidekickSource, /filterSidekickModelOptionsByProvider/);
  assert.match(sidekickSource, /filterSidekickModelOptions/);
  assert.match(sidekickSource, /modelsByProvider/);
  assert.match(sidekickSource, /<SelectorRow/);
});
