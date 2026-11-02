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
