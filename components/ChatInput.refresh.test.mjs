import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const start = source.indexOf("    hasRefreshRisk() {");
const end = source.indexOf("    insertIfEmpty(", start);
assert.ok(start > 0 && end > start);

function fixture() {
  const ctx = {
    valueRef: { current: "" }, textareaRef: { current: { value: "" } },
    attachedImagesRef: { current: [] }, pendingImageCountRef: { current: 0 }, quotesRef: { current: [] },
    statePending: false, isStreaming: false, builtinCommandPendingRef: { current: false },
  };
  const hasRefreshRisk = vm.runInNewContext(stripTypeScriptTypes(`({${source.slice(start, end)}}).hasRefreshRisk`), ctx);
  return { ctx, hasRefreshRisk };
}

test("composer reports unsent content, in-progress attachments and active submissions", () => {
  assert.equal(fixture().hasRefreshRisk(), false);
  for (const setRisk of [
    ctx => { ctx.valueRef.current = " "; },
    ctx => { ctx.textareaRef.current.value = "unsent"; },
    ctx => { ctx.attachedImagesRef.current = [{}]; },
    ctx => { ctx.pendingImageCountRef.current = 1; },
    ctx => { ctx.quotesRef.current = [{}]; },
    ctx => { ctx.statePending = true; },
    ctx => { ctx.isStreaming = true; },
    ctx => { ctx.builtinCommandPendingRef.current = true; },
  ]) {
    const { ctx, hasRefreshRisk } = fixture();
    setRisk(ctx);
    assert.equal(hasRefreshRisk(), true);
  }
});

test("insertIfEmpty reports whether a quote was inserted without overwriting a draft", () => {
  const insertStart = source.indexOf("    insertIfEmpty(text:");
  const insertEnd = source.indexOf("    replaceMessage(", insertStart);
  assert.ok(insertStart > 0 && insertEnd > insertStart);
  const ctx = {
    textareaRef: { current: { value: "" } }, value: "", valueRef: { current: "" },
    attachedImagesRef: { current: [] }, pendingDraftFocusRef: { current: null }, draftKey: "draft",
    setValue(value) { ctx.saved = value; }, setAttachedImages(fn) { fn([]); },
    draftImagesToAttachedImages: () => [], revokeImagePreview() {}, setAtQuery() {},
  };
  const insertIfEmpty = vm.runInNewContext(stripTypeScriptTypes(`({${source.slice(insertStart, insertEnd)}}).insertIfEmpty`), ctx);
  assert.equal(insertIfEmpty("quote"), true);
  assert.equal(ctx.saved, "quote");
  ctx.saved = undefined;
  ctx.textareaRef.current.value = "existing draft";
  assert.equal(insertIfEmpty("new quote"), false);
  assert.equal(ctx.saved, undefined);
  ctx.textareaRef.current.value = "";
  ctx.attachedImagesRef.current = [{}];
  assert.equal(insertIfEmpty("new quote"), false);
  assert.equal(ctx.saved, undefined);
});
