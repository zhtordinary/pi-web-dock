import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translateMessage } from "../lib/i18n/format.ts";
import { enLocale } from "../lib/i18n/messages/en.ts";
import { zhCNLocale } from "../lib/i18n/messages/zh-CN.ts";
import { zhTWLocale } from "../lib/i18n/messages/zh-TW.ts";

const source = await readFile(new URL("./BatchContinueButton.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("BatchContinueButton.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(predicate) {
  const visit = node => predicate(node) ? node : ts.forEachChild(node, visit);
  const node = visit(tree);
  assert.ok(node, "the actual batch continue wiring must exist");
  return node;
}
function evaluate(node, context) {
  return runInNewContext(ts.transpileModule(`(${node.getText(tree).replace(/^export /, "")})`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
}

test("the batch button shares candidate helpers, live events and activity refresh", () => {
  assert.match(source, /filterContinuableSessions\(data\?\.sessions\)/);
  assert.match(source, /continueAllSessions\(sessions, localDeviceId\)/);
  assert.match(source, /openReaderEventSource\(\["activity", "running", "peer_state"\]\)/);
  assert.match(source, /reader:refresh-activity/);
  assert.match(source, /data-action="batch-continue"/);
  assert.match(source, /shouldShowBatchContinue\(count\) \|\| isContinuing/);
  assert.match(source, /result && result\.issues\.length > 0 && <BatchContinueFeedback/);
  assert.match(source, /issues\.length === 0\) return null/);
});

test("rapid clicks submit one batch and retain results after refreshing away the candidates", async () => {
  const handler = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === "handleContinueAll").initializer;
  const states = [], results = [], callbacks = [], refreshes = [];
  let calls = 0, release;
  const done = new Promise(resolve => { release = resolve; });
  const context = {
    continuingRef: { current: false }, sessions: [{ session: { id: "s" }, device: { id: "local" } }], localDeviceId: "local",
    setIsContinuing: value => states.push(value), setResult: value => results.push(value),
    continueAllSessions: async () => { calls++; return done; },
    clearSessionActivityCache() {}, window: { dispatchEvent() {} }, CustomEvent: class {},
    onContinued: result => callbacks.push(result),
    refreshContinuableSessions: async force => { refreshes.push(force); context.sessions = []; },
  };
  const submit = evaluate(handler, context);
  const pending = submit();
  await submit();
  assert.equal(calls, 1);
  const result = { succeeded: ["s"], failed: [], issues: [] };
  release(result);
  await pending;
  assert.deepEqual(states, [true, false]);
  assert.equal(results.at(-1), result);
  assert.equal(callbacks[0], result);
  assert.deepEqual(refreshes, [true]);
  assert.equal(context.continuingRef.current, false);
  assert.equal(context.sessions.length, 0);
});

test("rendered feedback distinguishes acceptance, rejection and uncertain transport results in every locale", () => {
  const feedback = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "BatchContinueFeedback");
  const result = {
    succeeded: ["accepted"], failed: ["rejected", "unconfirmed", "active"],
    issues: [
      { sessionId: "rejected", deviceId: "local", label: "Rejected task", error: "Run changed", uncertain: false },
      { sessionId: "unconfirmed", deviceId: "remote", label: "Remote task", error: "Remote request timed out", uncertain: true },
      { sessionId: "active", deviceId: "local", label: "Already active task", error: "The session has active work, queued input or a pending question", code: "runtime_busy", uncertain: false },
    ],
  };
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    const Feedback = evaluate(feedback, { React, useI18n: () => ({ t: (key, params) => translateMessage(locale.id, key, { [locale.id]: locale.messages }, params) }) });
    const html = renderToStaticMarkup(React.createElement(Feedback, { result, onClose() {} }));
    assert.match(html, /role="status"/);
    assert.match(html, /Rejected task/);
    assert.match(html, /Run changed/);
    assert.match(html, /Remote request timed out/);
    assert.doesNotMatch(html, /Already active task|The session has active work/);
    assert.match(html, /aria-label=/);
    assert.doesNotMatch(html, /session\.batchContinue/);
    assert.ok(html.includes(locale.messages["session.batchContinueAcceptedHint"]));
    assert.ok(html.includes(locale.messages["session.batchContinueUncertainHint"]));
    assert.ok(locale.messages["session.batchContinueTitle"].includes(locale.id === "en" ? "failed" : locale.id === "zh-CN" ? "失败" : "失敗"));
    const activeOnlyHtml = renderToStaticMarkup(React.createElement(Feedback, {
      result: { succeeded: [], failed: ["active"], issues: [result.issues[2]] }, onClose() {},
    }));
    assert.equal(activeOnlyHtml, "");
    const acceptedHtml = renderToStaticMarkup(React.createElement(Feedback, { result: { succeeded: ["accepted"], failed: [], issues: [] }, onClose() {} }));
    assert.ok(!acceptedHtml.includes(locale.messages["session.batchContinueUncertainHint"]));
    assert.doesNotMatch(acceptedHtml, /<ul/);
  }
});
