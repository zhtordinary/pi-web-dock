import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { isBase64ImageWithinLimits, MAX_ATTACHED_IMAGES } from "../lib/image-attachments.ts";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
function restoreHarness() {
  const writes = [];
  const ctx = {
    isBase64ImageWithinLimits, MAX_ATTACHED_IMAGES,
    canRestoreUserMessage: (text, images, pending) => !text.trim() && images === 0 && pending === 0,
    textareaRef: { current: null }, value: "", attachedImagesRef: { current: [] },
    pendingImageCountRef: { current: 0 }, pendingDraftFocusRef: { current: null },
    draftKey: "s", valueRef: { current: "" },
    draftImagesToAttachedImages: (images) => images.slice(0, MAX_ATTACHED_IMAGES),
    setValue: (value) => writes.push(value), setAtQuery() {}, setHistoryMenuOpen() {},
    setAttachedImages: (update) => update([]), revokeImagePreview() {},
  };
  const helpers = source.slice(source.indexOf("export function getUserMessageText"), source.indexOf("function revokeImagePreview"));
  const method = source.slice(source.indexOf("    replaceMessage(message: UserMessage) {"), source.indexOf("    prependText(text:", source.indexOf("    replaceMessage(message: UserMessage) {")));
  vm.createContext(ctx);
  vm.runInContext(stripTypeScriptTypes(helpers.replaceAll("export function", "function") + "\nconst handle = ({" + method + "}).replaceMessage; globalThis.restore = handle;"), ctx);
  return { ctx, writes };
}

test("unresolved URL images never report successful composer restoration", () => {
  const h = restoreHarness();
  assert.equal(h.ctx.restore({ role: "user", content: [{ type: "image", source: { type: "url", url: "/api/image" } }] }), false);
  assert.equal(h.writes.length, 0);
});

test("complete image-only and text-plus-image originals restore every attachment", () => {
  for (const text of ["", "question"]) {
    const h = restoreHarness();
    const content = [...(text ? [{ type: "text", text }] : []), { type: "image", data: "AAAA", mimeType: "image/png" }];
    assert.equal(h.ctx.restore({ role: "user", content }), true);
    assert.equal(h.ctx.attachedImagesRef.current.length, 1);
    assert.equal(h.ctx.attachedImagesRef.current[0].data, "AAAA");
    assert.equal(h.ctx.valueRef.current, text);
  }
});

test("a partially invalid image set is rejected atomically", () => {
  const h = restoreHarness();
  assert.equal(h.ctx.restore({ role: "user", content: [
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "image", data: "broken", mimeType: "image/png" },
  ] }), false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.ctx.attachedImagesRef.current.length, 0);
});
