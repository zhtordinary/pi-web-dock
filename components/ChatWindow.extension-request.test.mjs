import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const dialogHelperSource = source.slice(
  source.indexOf("function normalizeExtensionDialogText"),
  source.indexOf("function ExtensionWaitingCount"),
);
const dialogSource = source.slice(
  source.indexOf("function ExtensionDialog"),
  source.indexOf("function ExtensionCustomPanel"),
);
const customSource = source.slice(source.indexOf("function ExtensionCustomPanel"));

test("confines extension overlays to the content region above the composer", () => {
  assert.doesNotMatch(source, /function ExtensionRequestSheet/);
  assert.match(source, /<ExtensionDialog/);
  assert.match(source, /<ExtensionCustomPanel/);
  assert.match(dialogSource, /position: "absolute"[\s\S]*?inset: 0/);
  assert.match(dialogSource, /pointerEvents: "none"/);
  assert.match(dialogSource, /pointerEvents: "auto"/);
  assert.match(customSource, /position: "absolute"[\s\S]*?inset: 0/);
  assert.doesNotMatch(source, /z-\[100\]|zIndex: 100/);
});

test("keeps collapse and exposes unified Reader select controls without duplicate header Esc button", () => {
  assert.match(dialogSource, /setCollapsed\(true\)/);
  assert.match(dialogSource, /chat\.extensionCollapse/);
  assert.match(dialogSource, /chat\.extensionNavigation/);
  assert.match(dialogSource, /chat\.extensionMoveUp/);
  assert.match(dialogSource, /chat\.extensionMoveDown/);
  assert.match(dialogSource, /chat\.extensionConfirm/);
  assert.match(dialogSource, /chat\.cancel/);
  assert.match(dialogSource, /className="extension-dialog-stepper"/);
  assert.match(dialogSource, /className="config-button config-button-small config-button-secondary"/);
  assert.match(dialogSource, /className="config-button config-button-small config-button-primary"/);
  assert.equal((dialogSource.match(/>Esc<\/span>/g) ?? []).length, 1);
  assert.doesNotMatch(dialogSource, /chat\.extensionSkip/);
});

test("renders extension confirmation, multi-section previews, and options as markdown", () => {
  assert.match(source, /import \{ MarkdownBody \} from "\.\/MarkdownBody"/);
  assert.match(dialogHelperSource, /matchAll\(previewHeaderRegex\)/);
  assert.match(dialogHelperSource, /replace\(\/\\\\n\/g, "\\n"\)/);
  assert.match(dialogSource, /<MarkdownBody>\{activePreview\.text\}<\/MarkdownBody>/);
  assert.match(dialogSource, /<MarkdownBody>\{request\.message\}<\/MarkdownBody>/);
  assert.match(dialogSource, /role="button"[\s\S]*?data-extension-option[\s\S]*?<div inert>[\s\S]*?<MarkdownBody>\{option\}<\/MarkdownBody>/);
  assert.match(dialogSource, /optionRefs\.current\[index\]/);
  assert.doesNotMatch(dialogSource, /maxHeight:\s*100/);
});

test("uses a single unified adaptive scrollable body with justified typography", () => {
  assert.match(dialogSource, /className="extension-dialog-surface"/);
  assert.ok(dialogSource.includes('maxHeight: "min(680px, 100%)"'));
  assert.doesNotMatch(dialogSource, /height:\s*isSelect/);
  assert.doesNotMatch(dialogSource, /min\(280px,\s*34%\)/);
  assert.match(dialogSource, /className="extension-dialog-body"[\s\S]*?flex: "1 1 auto",[\s\S]*?minHeight: 0,[\s\S]*?overflowY: "auto"/);
  assert.match(dialogSource, /className="extension-dialog-question"[\s\S]*?textAlign: "justify"/);
  assert.match(cssSource, /\.extension-dialog-surface \.markdown-body[\s\S]*?text-align: justify/);
  assert.match(cssSource, /\.extension-dialog-surface \[data-extension-option\] \.markdown-body ol[\s\S]*?list-style: none/);
});

test("identifies Side Ask-owned permission dialogs and custom panels", () => {
  assert.equal((dialogSource.match(/request\.sideAskRunId/g) ?? []).length, 3);
  assert.match(dialogSource, /aria-label=\{`\$\{request\.sideAskRunId/);
  assert.match(dialogSource, /request\.sideAskLabel/);
  assert.match(customSource, /request\.sideAskRunId[\s\S]*?request\.sideAskLabel/);
});

test("resets collapse state when a new extension request arrives", () => {
  assert.match(source, /<ExtensionDialog\s+key=\{extensionDialog\.id\}/);
  assert.match(source, /<ExtensionCustomPanel\s+key=\{extensionCustomUi\.id\}/);
});

test("parses multi-option preview blocks, badge prefix, escaped newlines, and slash break opportunities", () => {
  const fnBody = dialogHelperSource
    .replace(/interface ExtensionDialogPreviewSection \{[\s\S]*?\}\n\n/, "")
    .replace(/function normalizeExtensionDialogText\(text: string\): string/g, "function normalizeExtensionDialogText(text)")
    .replace(/function addSlashBreakOpportunities\(text: string\): string/g, "function addSlashBreakOpportunities(text)")
    .replace(/function parseExtensionDialogTitle\(rawTitle: string\): \{[\s\S]*?\} \{/, "function parseExtensionDialogTitle(rawTitle) {")
    .replace(/const previews: ExtensionDialogPreviewSection\[\] = \[\];/, "const previews = [];");
  const parseTitle = new Function(`${fnBody}\nreturn parseExtensionDialogTitle;`)();
  const sample = [
    "[下一步] 异步面板优化已完成开发期检查：已增加 provider/model/thinking 读取；focused 22/22 通过。下一步怎么处理？",
    "",
    "--- 1. 暂存等待整合 (推荐) preview ---",
    "当前状态: \\n\\nReader 主线      保持不变\\n本次优化        保留候选",
    "",
    "--- 2. 立即合入并发布 30142 preview ---",
    "| 立即合入主线并分发 30142",
  ].join("\n");
  const parsed = parseTitle(sample);
  assert.equal(parsed.badge, "下一步");
  assert.equal(
    parsed.title,
    "异步面板优化已完成开发期检查：已增加 provider/model/thinking 读取；focused 22/22 通过。下一步怎么处理？",
  );
  assert.ok(parsed.formattedTitle.includes("provider/\u200bmodel/\u200bthinking"));
  assert.equal(parsed.previews.length, 2);
  assert.deepEqual(parsed.previews[0], {
    label: "1. 暂存等待整合 (推荐)",
    optionIndex: 0,
    text: "当前状态: \n\nReader 主线      保持不变\n本次优化        保留候选",
  });
  assert.deepEqual(parsed.previews[1], {
    label: "2. 立即合入并发布 30142",
    optionIndex: 1,
    text: "立即合入主线并分发 30142",
  });
});

test("replaces radio circle with leading number badge that reflects selection and aligns with option text", () => {
  assert.doesNotMatch(dialogSource, /borderRadius:\s*"50%"/);
  assert.match(
    dialogSource,
    /data-extension-option[\s\S]*?<span[\s\S]*?className="extension-dialog-kbd"[\s\S]*?marginTop:\s*2[\s\S]*?\{index \+ 1\}[\s\S]*?<\/span>[\s\S]*?<div inert>[\s\S]*?<MarkdownBody>\{option\}<\/MarkdownBody>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*\);/,
  );
  assert.match(dialogSource, /color:\s*isSelected \? "var\(--accent\)" : "var\(--text-dim\)"/);
  assert.match(dialogSource, /borderColor:\s*isSelected \? "color-mix\(in srgb, var\(--accent\) 45%, var\(--border\)\)" : "var\(--border\)"/);
  assert.match(dialogSource, /background:\s*isSelected \? "color-mix\(in srgb, var\(--accent\) 12%, var\(--bg-panel\)\)" : "var\(--bg-panel\)"/);
});

test("shows queued request counts without replacing Reader terminal or confirmation layouts", () => {
  const waitingSource = source.slice(source.indexOf("function ExtensionWaitingCount"), source.indexOf("function ExtensionDialog("));
  assert.match(source, /<ExtensionDialog\s+key=\{extensionDialog.id\}\s+request=\{extensionDialog\}\s+waitingCount=\{waitingExtensionDialogCount\}/);
  assert.match(source, /<ExtensionCustomPanel\s+key=\{extensionCustomUi.id\}\s+request=\{extensionCustomUi\}\s+waitingCount=\{waitingExtensionCustomUiCount\}/);
  assert.match(waitingSource, /if \(count <= 0\) return null;[\s\S]*?t\("chat\.extensionMoreWaiting", \{ count \}\)/);
  assert.equal((dialogSource.match(/<ExtensionWaitingCount count=\{waitingCount\} \/>/g) ?? []).length, 2);
  assert.match(customSource, /<ExtensionWaitingCount count=\{waitingCount\} \/>/);
  assert.match(customSource, /extension-custom-terminal-input/);
  assert.match(customSource, /onClose: \(request: ExtensionCustomRequest\)/);
});
