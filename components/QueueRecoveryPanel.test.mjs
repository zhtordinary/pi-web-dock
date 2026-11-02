import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { QueueRecoveryPanel } = await jiti.import("./QueueRecoveryPanel.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const entry = (status = "committed", imageCount = 1) => ({ operationId: "saved-copy", status, createdAt: "now", expected: { bootId: "boot", queueRevision: 1 }, queue: { bootId: "boot", queueRevision: 1, steering: [{ itemId: "item-A", role: "user", text: "captured", hasImages: imageCount > 0, imageCount }], followUp: [] } });
function render(overrides = {}) {
  const recovery = { client: { hasDurableDraft: () => false }, entries: [], busy: null, loading: false, error: null, notice: null, copy: null, ...overrides };
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(QueueRecoveryPanel, { recovery })));
}

test("a saved recovery entry is discoverable without live queued messages; the normal empty state adds no panel", () => {
  assert.equal(render(), "");
  const html = render({ entries: [entry()] });
  assert.match(html, /aria-label="队列恢复"/);
  assert.match(html, /查找恢复副本/);
  assert.match(html, /可恢复到输入/);
});

test("an unknown prepared copy exposes inspect/export and explicit confirmation, never restore/send", () => {
  const html = render({ entries: [entry("prepared")] });
  assert.match(html, /清空结果尚不确定/);
  assert.match(html, /可能仍在队列，也可能已经执行/);
  assert.match(html, /查看副本/);
  assert.match(html, /下载完整副本/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /<button type="button" disabled="">确认已保存/);
  assert.doesNotMatch(html, /恢复到输入（不发送）/);
});

test("the acknowledgement phase is visible and all mutation actions are disabled", () => {
  const html = render({ entries: [entry()], busy: { operationId: "saved-copy", action: "confirm" }, client: { hasDurableDraft: () => true } });
  assert.match(html, /role="status">正在确认保存/);
  assert.match(html, /<button type="button" disabled="">重试确认/);
  const buttons = [...html.matchAll(/<button\b([^>]*)>/g)];
  assert.ok(buttons.length >= 5);
  assert.ok(buttons.every(([, attributes]) => attributes.includes('disabled=""')));
});

test("more than ten images explains why an empty input still cannot restore the batch", () => {
  const html = render({ entries: [entry("committed", 11)] });
  assert.match(html, /清空输入也无法一次装下/);
  assert.match(html, /不会截断图片/);
  assert.match(html, /<button type="button" disabled="">恢复到输入/);
  assert.match(html, /<button type="button">下载完整副本/);
});

test("preview renders the captured image bytes and escapes hostile text without script tags", () => {
  const captured = entry();
  captured.queue.steering[0].text = '</pre><script src="https://invalid.test/no-network"></script>';
  captured.queue.steering[0].images = [{ data: "AAAA", mimeType: "image/gif" }];
  const html = render({ entries: [entry()], copy: { ...captured, sessionId: "session-A" }, notice: "memoryOnly" });
  assert.match(html, /服务器仍保留完整副本/);
  assert.match(html, /src="data:image\/gif;base64,AAAA"/);
  assert.match(html, /&lt;script/);
  assert.doesNotMatch(html, /<script/);
});


test("many recovery records and an expanded preview stay inside a keyboard-scrollable viewport cap", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ ...entry(), operationId: `copy-${index}` }));
  const copy = { ...entry(), sessionId: "session-A" };
  copy.queue.steering[0].text = "Complete preview text remains available";
  const html = render({ entries, copy });
  const outerSection = html.match(/^<section[^>]*>/)?.[0];
  assert.ok(outerSection);
  assert.match(outerSection, /tabindex="0"/);
  assert.match(outerSection, /max-height:min\(320px, 35dvh\)/);
  assert.match(outerSection, /overflow-y:auto/);
  assert.match(outerSection, /box-sizing:border-box/);
  assert.equal([...html.matchAll(/<article\b/g)].length, 12, "scrolling does not truncate records");
  assert.match(html, /Complete preview text remains available/);
  assert.match(html, /<button type="button">下载完整副本/);
  assert.doesNotMatch(html, /tabindex="-1"/);
});

test("completed recovery notices do not leave an empty recovery panel behind", () => {
  assert.equal(render({ notice: "confirmed" }), "");
  assert.equal(render({ notice: "restored" }), "");
  assert.equal(render({ notice: "memoryOnly" }), "");
  assert.match(render({ warnings: ["A legacy recovery record is corrupt; its session is unknown"] }), /role="alert"/);
});
