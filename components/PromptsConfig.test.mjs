import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const settingsCssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const source = await readFile(new URL("./PromptsConfig.tsx", import.meta.url), "utf8");
const promptTypesSource = await readFile(new URL("../lib/custom-prompt-types.ts", import.meta.url), "utf8");

test("remote prompt requests bind peer in the query contract", () => {
  assert.match(source, /const \[pathname, rawQuery\] = path\.split\("\?", 2\)/);
  assert.match(source, /params\.set\("peer", remotePeer\)/);
  assert.match(source, /apiPath\(`custom-prompts\?id=/);
  assert.doesNotMatch(source, /\/api\/remote\/\$\{encodeURIComponent\(remotePeer\)\}/);
});

test("prompt editing closes on a clean backdrop click and confirms dirty drafts", () => {
  assert.match(source, /const initialFormRef = useRef/);
  assert.match(source, /const hasUnsavedChanges = editingId !== null/);
  assert.match(source, /if \(hasUnsavedChanges\) setCloseConfirmationOpen\(true\);\s*else cancelEdit\(\)/);
  assert.match(source, /event\.target === event\.currentTarget\) requestCloseEditor\(\)/);
  assert.match(source, /settings\.continueEditing/);
  assert.match(source, /settings\.discardAndClose/);
  assert.match(source, /settings\.saveAndClose/);
});

test("PromptsConfig exports component and uses card drag sorting", () => {
  assert.match(source, /export \{ CUSTOM_PROMPTS_CHANGED_EVENT \}/);
  assert.match(promptTypesSource, /export const CUSTOM_PROMPTS_CHANGED_EVENT/);
  assert.match(source, /export function PromptsConfig/);
  assert.match(source, /persistPromptOrder/);
  assert.match(source, /handlePromptDragStart/);
  assert.match(source, /handlePromptDragOver/);
  assert.match(source, /handlePromptDrop/);
  assert.match(source, /dataTransfer\.setData\("text\/custom-prompt-id"/);
  assert.match(source, /draggable=\{!reordering\}/);
  assert.match(source, /prompts-config-list/);
  assert.match(source, /prompts-config-card/);
  assert.ok(
    source.indexOf("<GripVertical") < source.indexOf('<div className="prompts-config-card-heading">'),
    "drag handle stays before the prompt text",
  );
  assert.match(settingsCssSource, /\.prompts-config-toolbar[\s\S]*min-height: 47px[\s\S]*padding: 7px 18px[\s\S]*background: var\(--bg\)/);
  assert.match(settingsCssSource, /\.prompts-config-toolbar-info[\s\S]*align-items: center[\s\S]*gap: 10px/);
  assert.match(settingsCssSource, /\.prompts-config-file-row[\s\S]*flex: 1 1 auto/);
  assert.match(settingsCssSource, /\.prompts-config-card-header[\s\S]*align-items: center/);
  assert.match(settingsCssSource, /\.prompts-config-card-header[\s\S]*min-height: 28px/);
  assert.doesNotMatch(settingsCssSource, /\.prompts-config-card-header[\s\S]*flex: 0 0 36px/);
  assert.match(settingsCssSource, /\.prompts-config-card[\s\S]*padding: 6px 8px 8px/);
  assert.match(settingsCssSource, /\.prompts-config-card-title[\s\S]*white-space: nowrap[\s\S]*text-overflow: clip/);
  assert.match(settingsCssSource, /\.prompts-config-card-actions[\s\S]*width: 28px/);
  assert.match(settingsCssSource, /\.prompts-config-card[\s\S]*min-height: 0/);
  assert.match(settingsCssSource, /\.prompts-config-list[\s\S]*grid-template-columns: repeat\(auto-fit/);
  assert.match(settingsCssSource, /\.prompts-config-card[\s\S]*cursor: grab/);
  assert.match(settingsCssSource, /@media \(max-width: 640px\)[\s\S]*\.prompts-config-list[\s\S]*grid-template-columns: 1fr/);
  assert.doesNotMatch(source, /onClick=\{\(\) => handleMove/);
  assert.doesNotMatch(source, /<Arrow(?:Up|Down)/);
  assert.match(source, /<ExternalLink/);
  assert.doesNotMatch(source, /<FileText/);
  assert.doesNotMatch(source, /fileLocationScope|modalSubtitle/);
  assert.match(source, /shortenPath/);
  assert.match(source, /handleDelete/);
  assert.match(source, /handleSave/);
  assert.match(source, /className="prompts-config-card-content"[\s\S]*onClick=\{\(\) => startEdit\(item\)\}/);
  assert.doesNotMatch(source, /<Edit2/);
  assert.match(source, /prompts-config-editor-backdrop/);
  assert.match(source, /role="dialog"[\s\S]*prompts-config-editor-title/);
  assert.match(source, /rows=\{10\}/);
  assert.doesNotMatch(source, /Inline Edit \/ New Form/);
});
