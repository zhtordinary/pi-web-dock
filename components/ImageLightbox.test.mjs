import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ImageLightbox.tsx", import.meta.url), "utf8");

test("image lightbox stays above Reader controls and respects safe areas", () => {
  assert.match(source, /zIndex: 1500/);
  assert.match(source, /paddingTop: "max\(14px, env\(safe-area-inset-top\)\)"/);
  assert.match(source, /paddingRight: "max\(16px, env\(safe-area-inset-right\)\)"/);
  assert.match(source, /paddingBottom: "max\(16px, env\(safe-area-inset-bottom\)\)"/);
});

test("scaled image frame does not block backdrop hit testing", () => {
  assert.match(source, /flexShrink: 0,[\s\S]*?pointerEvents: "none",[\s\S]*?transform: `translate3d/);
  assert.match(source, /<img[\s\S]*?pointerEvents: "auto"/);
});

test("close button stops propagation before closing", () => {
  assert.match(source, /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*onClose\(\);\s*\}\}/);
});

test("the global surface acknowledges readiness after its portal mounts", () => {
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*onReady\?\.\(\);/);
  assert.doesNotMatch(source, /notifyEmbeddedModalState/);
});

test("lightbox mounts at document root and centers independently of its controls", () => {
  assert.match(source, /return createPortal\(/);
  assert.match(source, /document\.body/);
  assert.match(source, /data-image-preview-close-controls[\s\S]*?position: "absolute",[\s\S]*?top: 0/);
  assert.match(source, /data-image-preview-zoom-controls[\s\S]*?position: "absolute",[\s\S]*?bottom: 0/);
});

test("portaled preview pointer events do not dismiss the underlying drawer", () => {
  assert.match(source, /aria-label="Image preview"[\s\S]*?onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
});

test("transparent control bands close when clicked outside their buttons", () => {
  for (const marker of ["data-image-preview-close-controls", "data-image-preview-zoom-controls"]) {
    const start = source.indexOf(marker);
    const end = source.indexOf("style={{", start);
    assert.ok(start >= 0 && end > start, `${marker} control band is present`);
    assert.match(
      source.slice(start, end),
      /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*if \(event\.target === event\.currentTarget\) onClose\(\);\s*\}\}/,
    );
  }
});
