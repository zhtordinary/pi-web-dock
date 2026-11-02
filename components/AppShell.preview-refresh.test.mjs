import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(predicate) {
  const visit = node => predicate(node) ? node : ts.forEachChild(node, visit);
  const node = visit(tree);
  assert.ok(node, "the real AppShell update wiring must be present");
  return node;
}
function effect(marker, context) {
  const call = findNode(node => ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
    && marker(node.arguments[0].getText(tree)));
  return runInNewContext(ts.transpileModule(`(${call.arguments[0].getText(tree)})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
}

function fixture() {
  const updates = [], requests = [], intervals = [], listeners = {}, stream = { close() {} };
  const ctx = {
    embeddedReaderMode: false, BUILT_READER_BUILD_ID: "old-build", BUILT_READER_COMMIT: "c".repeat(40),
    openReaderEventSource: () => stream,
    setReaderUpdate: update => updates.push(update), setPreviewUpdate: update => updates.push(update),
    window: { setInterval(callback, ms) { intervals.push({ callback, ms }); return 1; }, clearInterval() {} },
    document: { addEventListener(name, callback) { listeners[name] = callback; }, removeEventListener() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ channel: "production", buildId: "new-build", readerCommit: "d".repeat(40) }) };
    },
  };
  return { ctx, updates, requests, intervals, listeners, stream };
}
const poll = ctx => effect(text => text.includes('fetch("/api/preview-build"') || text.includes('fetch("/api/reader/build"'), ctx);
const drain = () => new Promise(resolve => setImmediate(resolve));

function refreshClickFixture() {
  const button = findNode(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "button"
    && node.getText(tree).includes("reader.refresh"));
  const onClick = button.openingElement.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(tree) === "onClick");
  assert.ok(onClick?.initializer && ts.isJsxExpression(onClick.initializer) && onClick.initializer.expression);
  const calls = { reload: 0, confirmations: [], queued: 0 };
  const ctx = {
    document: {}, readerRefreshRequested: false,
    setReaderRefreshRequested() { calls.queued++; },
    window: {
      confirm(message) { calls.confirmations.push(message); return ctx.confirmed; },
      location: { reload() { calls.reload++; } },
    },
    translate: key => key,
    hasRefreshRisk: (_doc, state) => Boolean(state.pending || state.dirtyFileTabs),
    hasMemoryDraftContent: () => false,
    chatInputRef: { current: null },
    pendingRestoreMessage: null, pendingAgentSelectionRef: { current: null },
    pendingTalkMapGhostConversionRef: { current: null }, pendingEmbeddedNewSessionRef: { current: null },
    terminalTabs: [], pendingRemoteMutations: [], mutationRecoveryBusy: false, fileTabs: [],
    selectedSession: { id: "open-session" }, remoteSession: null, embeddedReaderUrl: null,
    confirmed: false,
  };
  const click = runInNewContext(ts.transpileModule(`(${onClick.initializer.expression.getText(tree)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, ctx);
  return { ctx, calls, click };
}

test("refresh now reloads an open session immediately when there is no unsaved work", () => {
  const { calls, click } = refreshClickFixture();
  click();
  assert.equal(calls.reload, 1);
  assert.deepEqual(calls.confirmations, []);
  assert.equal(calls.queued, 0);
});

test("refresh now asks before risking unsaved work and remains retryable after cancellation", () => {
  for (const risk of [
    ctx => { ctx.fileTabs = [{ dirty: true }]; },
    ctx => { ctx.hasMemoryDraftContent = () => true; },
    ctx => { ctx.chatInputRef.current = { hasRefreshRisk: () => true }; },
    ctx => { ctx.pendingRestoreMessage = {}; },
    ctx => { ctx.pendingAgentSelectionRef.current = {}; },
    ctx => { ctx.pendingTalkMapGhostConversionRef.current = {}; },
    ctx => { ctx.pendingEmbeddedNewSessionRef.current = {}; },
    ctx => { ctx.terminalTabs = [{}]; },
    ctx => { ctx.pendingRemoteMutations = [{}]; },
    ctx => { ctx.mutationRecoveryBusy = true; },
  ]) {
    const { ctx, calls, click } = refreshClickFixture();
    risk(ctx);
    click();
    assert.equal(calls.reload, 0);
    assert.deepEqual(calls.confirmations, ["reader.refreshConfirm"]);
    ctx.confirmed = true;
    click();
    assert.equal(calls.reload, 1);
    assert.equal(calls.confirmations.length, 2);
  }
});

test("both channels retain build identity, polling and safe-refresh wiring", async () => {
  const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(source, /fetch\("\/api\/reader\/build"/);
  assert.match(source, /canRefreshPreview\(document/);
  assert.match(source, /reader\.updateAvailable/);
  assert.doesNotMatch(source, /pi-web-reader-test-30142|\.last-build\.json/);
  assert.match(nextConfig, /\.pi-web-reader-release\.json/);
  assert.match(nextConfig, /NEXT_PUBLIC_READER_COMMIT/);
});

test("automatic refresh still protects open sessions and other in-memory drafts", async () => {
  const { canRefreshPreview } = await createJiti(import.meta.url).import("../lib/preview-refresh.ts");
  let reloads = 0, check;
  const ctx = {
    readerUpdate: { version: "new" },
    document: { visibilityState: "hidden", activeElement: null, querySelector: () => null, querySelectorAll: () => [] },
    window: { location: { reload() { reloads++; } }, setInterval(callback) { check = callback; return 1; }, clearInterval() {} },
    canRefreshPreview, hasMemoryDraftContent: () => false, chatInputRef: { current: null },
    selectedSession: { id: "open-session" }, remoteSession: null, embeddedReaderUrl: null,
    newSessionCwd: null, pendingRestoreMessage: null, fileTabs: [], terminalTabs: [], pendingRemoteMutations: [], mutationRecoveryBusy: false,
    activeNewSessionDraftKeyRef: { current: null }, remoteNewSessionDraftKeyRef: { current: null },
    pendingTalkMapGhostConversionRef: { current: null }, pendingEmbeddedNewSessionRef: { current: null }, pendingAgentSelectionRef: { current: null },
  };
  const stop = effect(text => text.includes("canRefreshPreview(document"), ctx);
  assert.equal(reloads, 0);
  ctx.selectedSession = null;
  ctx.hasMemoryDraftContent = () => true;
  check();
  assert.equal(reloads, 0);
  ctx.hasMemoryDraftContent = () => false;
  check();
  assert.equal(reloads, 1);
  stop();
});

test("live build changes preserve the server's channel in the notification", () => {
  for (const channel of ["production", "preview"]) {
    const f = fixture();
    const stop = effect(text => text.includes('openReaderEventSource(["runtime_identity"])'), f.ctx);
    f.stream.onmessage({ data: JSON.stringify({ buildId: "old-build", readerCommit: "c".repeat(40), channel }) });
    assert.equal(f.updates.length, 0);
    f.stream.onmessage({ data: JSON.stringify({ buildId: "new-build", readerCommit: "d".repeat(40), channel }) });
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].version, "d".repeat(40));
    assert.equal(f.updates[0].channel, channel);
    stop();
  }
});

test("polling checks the same channel every minute and on visibility changes", async () => {
  const f = fixture(), stop = poll(f.ctx);
  await drain();
  assert.equal(f.requests[0].url, "/api/reader/build");
  assert.equal(f.requests[0].options.cache, "no-store");
  assert.equal(f.updates[0].version, "d".repeat(40));
  assert.equal(f.updates[0].channel, "production");
  assert.equal(f.intervals[0].ms, 60_000);
  f.listeners.visibilitychange();
  await drain();
  assert.equal(f.requests.length, 2);
  stop();
});

test("polling detects a new build of the same commit and ignores late replies after cleanup", async () => {
  const f = fixture();
  f.ctx.fetch = async () => ({ ok: true, json: async () => ({ channel: "preview", buildId: "new-build", readerCommit: f.ctx.BUILT_READER_COMMIT }) });
  poll(f.ctx);
  await drain();
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].channel, "preview");
  const late = fixture();
  let resolve;
  late.ctx.fetch = () => new Promise(done => { resolve = done; });
  const stop = poll(late.ctx);
  stop();
  resolve({ ok: true, json: async () => ({ channel: "production", buildId: "new-build", readerCommit: "d".repeat(40) }) });
  await drain();
  assert.equal(late.updates.length, 0);
});

test("rendered update notices distinguish production, preview and unknown channels in every locale", async () => {
  const notice = findNode(node => ts.isJsxElement(node) && node.openingElement.attributes.getText(tree).includes('role="status"')
    && node.getText(tree).includes(".updateAvailable"));
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  for (const [file, name] of [["en", "enLocale"], ["zh-CN", "zhCNLocale"], ["zh-TW", "zhTWLocale"]]) {
    const locale = (await jiti.import(`../lib/i18n/messages/${file}.ts`))[name];
    for (const channel of ["production", "preview", undefined]) {
      const element = runInNewContext(ts.transpileModule(`(${notice.getText(tree)});`, {
        compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
      }).outputText, {
        React, readerUpdate: { version: "new", channel },
        translate: key => locale.messages[key] ?? key,
      });
      const html = renderToStaticMarkup(element);
      if (channel === "production") { assert.match(html, /30141/); assert.doesNotMatch(html, /30142/); }
      else if (channel === "preview") { assert.match(html, /30142/); assert.doesNotMatch(html, /30141/); }
      else { assert.match(html, /Reader/); assert.doesNotMatch(html, /30141|30142/); }
      assert.doesNotMatch(html, /reader\.[a-zA-Z]+/);
      const expectedRefreshLabel = { en: "Refresh now", "zh-CN": "现在刷新", "zh-TW": "現在重新整理" }[locale.id];
      assert.equal(locale.messages["reader.refreshNow"], expectedRefreshLabel);
      assert.ok(locale.messages["reader.refreshConfirm"]);
      assert.ok(html.includes(expectedRefreshLabel));
    }
  }
});
