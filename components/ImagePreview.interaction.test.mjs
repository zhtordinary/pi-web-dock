import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const {
  activateNativeImagePreview,
  clampImagePreviewPan,
  deactivateNativeImagePreview,
  finishImagePreviewPointerDrag,
  getImagePreviewInitialIndex,
  getImagePreviewNextIndex,
  getImagePreviewWheelZoom,
} = await jiti.import("./ImagePreview.tsx");
const { imageSource } = await jiti.import("./MessageView.tsx");

test("mock native dialog lifecycle shows, focuses, closes, and restores", () => {
  const events = [];
  const dialog = {
    open: false,
    showModal() {
      this.open = true;
      events.push("showModal");
    },
    close() {
      this.open = false;
      events.push("close");
    },
  };

  activateNativeImagePreview(dialog, () => events.push("focus-close"));
  assert.deepEqual(events, ["showModal", "focus-close"]);
  deactivateNativeImagePreview(dialog, () => events.push("focus-trigger"));
  assert.deepEqual(events, ["showModal", "focus-close", "close", "focus-trigger"]);
});

test("prop changes and Arrow navigation resolve a bounded gallery index", () => {
  assert.equal(getImagePreviewInitialIndex("b", ["a", "b", "c"], undefined), 1);
  assert.equal(getImagePreviewInitialIndex("c", ["c", "d"], 0), 0);
  assert.equal(getImagePreviewInitialIndex("missing", ["a", "b"], 9), 1);
  assert.equal(getImagePreviewNextIndex(0, -1, 3), 0);
  assert.equal(getImagePreviewNextIndex(1, 1, 3), 2);
  assert.equal(getImagePreviewNextIndex(2, 1, 3), 2);
});

test("wheel zoom, bounded pan, pointercancel, and drag-click suppression use executable fixtures", () => {
  assert.equal(getImagePreviewWheelZoom(1, -100).toFixed(2), "1.05");
  assert.equal(getImagePreviewWheelZoom(0.5, 100), 0.5);
  assert.deepEqual(
    clampImagePreviewPan({ x: 100, y: -100 }, 2, { clientWidth: 100, clientHeight: 80 }, { offsetWidth: 80, offsetHeight: 60 }),
    { x: 30, y: -20 },
  );
  assert.deepEqual(finishImagePreviewPointerDrag(null, 30, 30), { suppressClick: false });
  assert.deepEqual(finishImagePreviewPointerDrag({ startX: 10, startY: 10 }, 12, 12), { suppressClick: false });
  assert.deepEqual(finishImagePreviewPointerDrag({ startX: 10, startY: 10 }, 20, 10), { suppressClick: true });
});

test("remote image sources preserve peer routing while data images remain local", () => {
  assert.equal(
    imageSource({ source: { type: "url", url: "/api/files/Pictures/photo.png" } }, "mac mini"),
    "/api/remote/files/Pictures/photo.png?peer=mac%20mini",
  );
  assert.equal(
    imageSource({ source: { type: "base64", media_type: "image/png", data: "AQID" } }),
    "data:image/png;base64,AQID",
  );
});

test("local image paths use the session-scoped file API", () => {
  const image = { source: { type: "url", url: "/Volumes/project/Pictures/generated.png" } };
  assert.equal(
    imageSource(image, undefined, "session-1"),
    "/api/files/Volumes/project/Pictures/generated.png?type=read&sessionId=session-1",
  );
  assert.equal(
    imageSource(image, "mac mini", "session-1"),
    "/api/remote/files/Volumes/project/Pictures/generated.png?type=read&sessionId=session-1&peer=mac%20mini",
  );
  assert.equal(
    imageSource({ source: { type: "url", url: "https://example.com/generated.png" } }, "mac mini", "session-1"),
    "https://example.com/generated.png",
  );
});
