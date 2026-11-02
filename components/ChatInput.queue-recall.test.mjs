import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const start = source.indexOf("    availableImageSlots() {");
const end = source.indexOf("    prependText(text:", start);
assert.ok(start > 0 && end > start);
function fixture(currentCount = 0, pending = 0) {
  const original = Array.from({ length: currentCount }, (_, i) => ({ data: `existing-${i}`, mimeType: "image/png" }));
  const ctx = {
    MAX_ATTACHED_IMAGES: 10,
    getDraft: () => null, isRecalledDraftDurable: () => true, quotesRef: { current: [] }, setRecalledDraft() {},
    attachedImagesRef: { current: original }, pendingImageCountRef: { current: pending },
    textareaRef: { current: null }, valueRef: { current: "current" }, pendingDraftFocusRef: { current: null }, draftKey: "draft",
    isBase64ImageWithinLimits: image => Boolean(image?.data && image?.mimeType),
    draftImageToAttachedImage: image => ({ ...image, previewUrl: "preview" }),
    setValue(value) { ctx.value = value; }, setAttachedImages(images) { ctx.images = images; }, setAtQuery() {},
  };
  vm.runInNewContext(stripTypeScriptTypes(`globalThis.handle = {${source.slice(start, end)}};`), ctx);
  return ctx;
}
const images = count => Array.from({ length: count }, (_, i) => ({ data: `queued-${i}`, mimeType: "image/png" }));
test("recall capacity includes existing and in-progress attachments", () => {
  const ctx = fixture(6, 2);
  assert.equal(ctx.handle.availableImageSlots(), 2);
  assert.equal(ctx.handle.prependQueuedDraft("queued", images(3)), false);
  assert.equal(ctx.valueRef.current, "current");
  assert.equal(ctx.attachedImagesRef.current.length, 6);
  assert.equal(ctx.pendingDraftFocusRef.current, null);
});
test("an accepted queue recall keeps every image and updates refs atomically", () => {
  const ctx = fixture(7);
  assert.equal(ctx.handle.prependQueuedDraft("queued", images(3)), true);
  assert.equal(ctx.valueRef.current, "queued\n\ncurrent");
  assert.equal(ctx.attachedImagesRef.current.length, 10);
  assert.deepEqual(Array.from(ctx.attachedImagesRef.current.slice(0, 3), image => image.data), ["queued-0", "queued-1", "queued-2"]);
  assert.equal(ctx.handle.availableImageSlots(), 0);
  assert.equal(ctx.handle.prependQueuedDraft("another", images(1)), false);
  assert.equal(ctx.attachedImagesRef.current.length, 10);
});

test("a persisted recall operation is never prepended twice after reload", () => {
  const ctx = fixture(10);
  ctx.getDraft = () => ({ recalledQueueOperations: ["operation-A"] });
  assert.equal(ctx.handle.hasQueuedDraft("operation-A"), true);
  assert.equal(ctx.handle.prependQueuedDraft("again", images(1), "operation-A"), true);
  assert.equal(ctx.valueRef.current, "current");
  assert.equal(ctx.attachedImagesRef.current.length, 10);
});

test("server-backed recall remains visible when browser persistence is unavailable", () => {
  const ctx = fixture(1);
  ctx.setRecalledDraft = () => ({ durable: false });
  ctx.isRecalledDraftDurable = () => false;
  assert.equal(ctx.handle.prependQueuedDraft("queued", images(1), "operation-A"), true);
  assert.equal(ctx.handle.isQueuedDraftDurable("operation-A"), false);
  assert.equal(ctx.valueRef.current, "queued\n\ncurrent");
  assert.equal(ctx.attachedImagesRef.current.length, 2);
});
