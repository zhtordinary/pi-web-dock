import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [appShell, lightbox] = await Promise.all([
  readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ImageLightbox.tsx", import.meta.url), "utf8"),
]);

test("the outer document owns embedded image previews without changing the iframe", () => {
  assert.match(appShell, /embeddedModalOpen && embeddedModalKind === "sidekick" \? \{ position: "fixed", inset: 0, zIndex: 1400 \}/);
  assert.match(appShell, /embeddedImagePreview && embeddedImagePreview\.phase !== "closed"[\s\S]*?<ImageLightbox[\s\S]*?onReady=\{acknowledgeEmbeddedImagePreview\}/);
  const iframe = appShell.slice(appShell.indexOf("<iframe ref={embeddedIframeRef}"), appShell.indexOf("<iframe ref={embeddedIframeRef}") + 1000);
  assert.doesNotMatch(iframe, /image-preview/);
  assert.doesNotMatch(appShell, /data-embedded-image-preview-backdrop/);
  assert.doesNotMatch(appShell, /embeddedModalOpen && \(embeddedModalKind === "sidekick" \|\| embeddedModalKind === "image-preview"\) \? \{ position: "fixed", inset: 0, zIndex: 1400 \}/);
  assert.doesNotMatch(appShell, /embeddedModalKind === "image-preview" \? \{ position: "fixed", top: "50%", left: "50%"/);
});

test("the preview itself remains a viewport-level centered overlay", () => {
  assert.match(lightbox, /return createPortal\([\s\S]*?position: "fixed",[\s\S]*?inset: 0,[\s\S]*?display: "flex"/);
  assert.match(lightbox, /zIndex: 1500/);
});
