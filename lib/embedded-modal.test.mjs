import assert from "node:assert/strict";
import test from "node:test";
import {
  connectEmbeddedImagePreview,
  EMBEDDED_IMAGE_PREVIEW_EVENT,
  EMBEDDED_IMAGE_PREVIEW_ACK_EVENT,
  EMBEDDED_IMAGE_PREVIEW_CLOSE_EVENT,
  EMBEDDED_IMAGE_PREVIEW_MAX_IMAGES,
  EMBEDDED_IMAGE_PREVIEW_MAX_SOURCE_LENGTH,
  EMBEDDED_IMAGE_PREVIEW_MAX_ALT_LENGTH,
  reduceEmbeddedImagePreview,
} from "./embedded-modal.ts";

const documentId = "a".repeat(32);
const image = "https://reader.example/api/files/image.png";
const prepare = (requestId, props = {}) => ({
  type: EMBEDDED_IMAGE_PREVIEW_EVENT, documentId, requestId, phase: "prepare", src: image, ...props,
});
const phase = (requestId, value) => ({ type: EMBEDDED_IMAGE_PREVIEW_EVENT, documentId, requestId, phase: value });

test("older close, ready and prepare messages cannot replace a newer image", () => {
  let state = reduceEmbeddedImagePreview(null, prepare(10));
  state = reduceEmbeddedImagePreview(state, prepare(11, { src: "data:image/png;base64,AQID" }));
  for (const message of [phase(10, "closed"), phase(10, "ready"), prepare(10)]) {
    assert.equal(reduceEmbeddedImagePreview(state, message), state);
  }
  assert.equal(state.requestId, 11);
  assert.equal(state.phase, "prepare");
  const closed = reduceEmbeddedImagePreview(state, phase(11, "closed"));
  assert.equal(closed.phase, "closed");
  assert.equal(reduceEmbeddedImagePreview(closed, phase(11, "ready")), closed);
  assert.equal(reduceEmbeddedImagePreview(closed, prepare(11)), closed);
});

test("the parent owns one unchanged image surface through prepare and ready", () => {
  let host = null;
  let receive;
  let triggerOpen = false;
  let closed = 0;
  const lifetime = connectEmbeddedImagePreview({
    post(message) { host = reduceEmbeddedImagePreview(host, message); },
    listen(listener) { receive = listener; return () => {}; },
  }, { src: image, images: [image, "data:image/png;base64,AQID"], initialIndex: 1, alt: "Photo" },
  () => { triggerOpen = true; }, () => { closed++; });
  assert.equal(host.phase, "prepare");
  assert.equal(triggerOpen, false, "the trigger waits for the mounted parent surface");
  const prepared = host;
  receive({ type: EMBEDDED_IMAGE_PREVIEW_ACK_EVENT, documentId: lifetime.documentId, requestId: lifetime.requestId + 1 });
  assert.equal(triggerOpen, false);
  // AppShell sends this only from the global surface's layout effect.
  receive({ type: EMBEDDED_IMAGE_PREVIEW_ACK_EVENT, documentId: lifetime.documentId, requestId: lifetime.requestId });
  assert.equal(triggerOpen, true);
  assert.equal(host.phase, "ready");
  assert.deepEqual({ ...host, phase: "prepare" }, prepared, "ready changes no image, gallery or geometry input");
  receive({ type: EMBEDDED_IMAGE_PREVIEW_CLOSE_EVENT, documentId: lifetime.documentId, requestId: lifetime.requestId });
  assert.equal(host.phase, "closed");
  assert.equal(closed, 1);
  receive({ type: EMBEDDED_IMAGE_PREVIEW_CLOSE_EVENT, documentId: lifetime.documentId, requestId: lifetime.requestId });
  assert.equal(closed, 1);
});

test("unmount before acknowledgement cancels the request and ignores its late ACK", () => {
  let host = null, receive, stopped = 0, ready = 0;
  const lifetime = connectEmbeddedImagePreview({
    post(message) { host = reduceEmbeddedImagePreview(host, message); },
    listen(listener) { receive = listener; return () => { stopped++; }; },
  }, { src: image }, () => { ready++; }, () => {});
  lifetime.close();
  lifetime.close();
  receive({ type: EMBEDDED_IMAGE_PREVIEW_ACK_EVENT, documentId: lifetime.documentId, requestId: lifetime.requestId });
  assert.equal(host.phase, "closed");
  assert.equal(stopped, 1);
  assert.equal(ready, 0);
});

test("unrelated modal cleanup cannot change the image lifecycle", () => {
  const state = reduceEmbeddedImagePreview(null, prepare(1));
  assert.equal(reduceEmbeddedImagePreview(state, {
    type: "pi-web-embedded-modal-state", kind: "config", open: false,
  }), state);
});

test("a new iframe document resets image request identities", () => {
  const closed = reduceEmbeddedImagePreview(reduceEmbeddedImagePreview(null, prepare(99)), phase(99, "closed"));
  assert.equal(reduceEmbeddedImagePreview(closed, prepare(1)), closed);
  const reloaded = reduceEmbeddedImagePreview(null, prepare(1, { documentId: "b".repeat(32) }));
  assert.equal(reloaded.requestId, 1);
  assert.equal(reduceEmbeddedImagePreview(reloaded, phase(1, "closed")), reloaded);
  assert.equal(reduceEmbeddedImagePreview(reloaded, prepare(999)), reloaded);
});

test("image messages bound galleries, source size and alt text", () => {
  assert.equal(reduceEmbeddedImagePreview(null, prepare(1, { src: "javascript:alert(1)" })), null);
  assert.equal(reduceEmbeddedImagePreview(null, prepare(1, { images: Array(EMBEDDED_IMAGE_PREVIEW_MAX_IMAGES + 1).fill(image) })), null);
  const largeSource = "data:image/png;base64," + "A".repeat(EMBEDDED_IMAGE_PREVIEW_MAX_SOURCE_LENGTH);
  assert.equal(reduceEmbeddedImagePreview(null, prepare(1, { src: largeSource })), null);
  const source = largeSource.slice(0, EMBEDDED_IMAGE_PREVIEW_MAX_SOURCE_LENGTH);
  assert.equal(reduceEmbeddedImagePreview(null, prepare(1, { images: Array(EMBEDDED_IMAGE_PREVIEW_MAX_IMAGES).fill(source) })), null);
  assert.equal(reduceEmbeddedImagePreview(null, prepare(1, { alt: "x".repeat(2048) })).alt.length, EMBEDDED_IMAGE_PREVIEW_MAX_ALT_LENGTH);
});
