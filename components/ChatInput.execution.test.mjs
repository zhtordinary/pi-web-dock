import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const render = props => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
  onSend() {}, onAbort() {}, isStreaming: false, ...props,
})));

test("idle parent remains editable while owned background work exposes Stop All", () => {
  const html = render({ canStop: true });
  assert.match(html, /aria-label="停止此会话全部执行"/);
  assert.match(html, /<textarea/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/);
  assert.doesNotMatch(render({ canStop: false }), /aria-label="停止此会话全部执行"/);
});
test("retrying activity exposes stop even when a historical transcript only supplies Continue", () => {
  assert.match(render({ canStop: true, unattended: true, onUnattendedChange() {}, continueUi: { kind: "awaiting", errorText: null } }), /aria-label="停止此会话全部执行"/);
});
test("stopping remains visible and cannot be submitted twice", () => {
  const html = render({ canStop: true, stopping: true });
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="正在停止全部执行"/);
});
