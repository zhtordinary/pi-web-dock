import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { checkModelImageLimits, modelImageResizeLimit, withModelImageResizeLimit } = await createJiti(import.meta.url).import("./model-image-limits.ts");

test("image limit edits preserve unknown nested data and remove only empty containers", () => {
  const original = { id: "a", inputLimits: { maxRequestBytes: 9000, images: { maxPerMessage: 3, resize: { maxWidth: 1200, jpegQuality: 90, maxBytes: 4000 } } } };
  const edited = withModelImageResizeLimit(original, "8000");
  assert.equal(edited.inputLimits.images.resize.maxBytes, 8000);
  assert.equal(original.inputLimits.images.resize.maxBytes, 4000);
  const cleared = withModelImageResizeLimit(edited, "");
  assert.deepEqual(cleared, { id: "a", inputLimits: { maxRequestBytes: 9000, images: { maxPerMessage: 3, resize: { maxWidth: 1200, jpegQuality: 90 } } } });
  assert.deepEqual(withModelImageResizeLimit({ inputLimits: { images: { resize: { maxBytes: 5 } } } }, ""), { inputLimits: undefined });
  const malformed = { inputLimits: { images: "custom" } };
  assert.equal(modelImageResizeLimit(malformed).editable, false);
  assert.equal(withModelImageResizeLimit(malformed, "500"), malformed);
});

test("resize limits require positive safe integers in models and overrides", () => {
  const config = value => ({ providers: { relay: { models: [{ id: "a", inputLimits: { images: { resize: { maxBytes: value } } } }] } } });
  checkModelImageLimits(config(1));
  checkModelImageLimits(config(Number.MAX_SAFE_INTEGER));
  for (const value of [0, -1, 1.5, null, "10", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => checkModelImageLimits(config(value)), /relay\/a.*positive safe integer/);
  }
  const draft = withModelImageResizeLimit({}, "1e3");
  assert.throws(() => checkModelImageLimits({ providers: { p: { models: [{ id: "x", ...draft }] } } }), /p\/x/);
  assert.throws(() => checkModelImageLimits({ providers: { p: { modelOverrides: { x: { inputLimits: { images: { resize: { maxBytes: 0 } } } } } } } }), /p\/x/);
});
