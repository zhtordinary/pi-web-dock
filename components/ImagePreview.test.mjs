import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ImagePreview.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("composer attachments open in the shared preview with a separate remove button", async () => {
  const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(inputSource, /import \{ ImagePreview \} from "\.\/ImagePreview"/);
  assert.match(
    inputSource,
    /<ImagePreview[\s\S]*?src=\{img\.previewUrl\}[\s\S]*?images=\{attachedImages\.map\(\(image\) => image\.previewUrl\)\}[\s\S]*?initialIndex=\{i\}[\s\S]*?<img[\s\S]*?src=\{img\.previewUrl\}[\s\S]*?<\/ImagePreview>\s*<button\s*type="button"\s*onClick=\{\(\) => removeImage\(i\)\}/,
  );
});

test("uses a native modal dialog and restores focus to its trigger", () => {
  assert.match(source, /useRef<HTMLDialogElement>\(null\)/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /closeButtonRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /const trigger = triggerRef\.current[\s\S]*?trigger\?\.isConnected[\s\S]*?trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(source, /createPortal/);
});

test("Escape closes image preview without reaching global shortcuts", () => {
  assert.match(
    source,
    /const closePreview = \(\) => \{[\s\S]*?dialogRef\.current\?\.open[\s\S]*?dialogRef\.current\.close\(\)[\s\S]*?setOpen\(false\)/,
  );
  assert.match(
    source,
    /event\.key (?:!== "Escape"[\s\S]*?closePreview\(\)|=== "Escape"[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?closePreview\(\))/,
  );
  assert.match(
    source,
    /onCancel=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?closePreview\(\)/,
  );
});

test("closes only when the backdrop itself is clicked", () => {
  assert.match(source, /event\.target === event\.currentTarget[\s\S]*?closePreview\(\)/);
});

test("keeps the preview and Pi-style close button inside mobile safe areas", () => {
  assert.match(
    cssSource,
    /\.image-preview-dialog \{[\s\S]*?env\(safe-area-inset-top\)[\s\S]*?env\(safe-area-inset-right\)[\s\S]*?env\(safe-area-inset-bottom\)[\s\S]*?env\(safe-area-inset-left\)/,
  );
  assert.match(
    cssSource,
    /\.image-preview-close \{[\s\S]*?top: max\(12px, env\(safe-area-inset-top\)\)[\s\S]*?right: max\(12px, env\(safe-area-inset-right\)\)[\s\S]*?border-radius: 6px[\s\S]*?background: var\(--bg-panel\)/,
  );
  assert.match(cssSource, /@media \(pointer: coarse\) \{[\s\S]*?\.image-preview-close \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(source, /<path d="M6 6l12 12M18 6 6 18" \/>/);
});

test("embedded image previews wait for the global surface acknowledgement", () => {
  assert.match(source, /activateNativeImagePreview/);
  assert.match(source, /deactivateNativeImagePreview/);
  assert.match(source, /startEmbeddedImagePreview\(/);
  assert.match(source, /previewLifecycleRef\.current\?\.close\(\)/);
  assert.match(source, /open && !previewLifecycleRef\.current\?\.embedded/);
  assert.doesNotMatch(source, /requestAnimationFrame|notifyEmbeddedModalState|prepareEmbeddedModal/);
});

test("keeps gallery navigation, zoom, wheel, and pan inside the native dialog", () => {
  assert.doesNotMatch(source, /ImageLightbox/);
  assert.match(source, /images\?: string\[\]/);
  assert.match(source, /initialIndex\?: number/);
  assert.match(source, /gallery\.length > 1/);
  assert.match(source, /ArrowLeft/);
  assert.match(source, /ArrowRight/);
  assert.match(source, /onWheel=\{\(event\) => \{/);
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /translate3d\(\$\{pan\.x\}px, \$\{pan\.y\}px, 0\)/);
  assert.match(source, /chat\.imageCounter/);
});

test("wires image groups through the native preview without replacing focus-safe ownership", async () => {
  const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const messageSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  const sidekickSource = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
  assert.match(inputSource, /<ImagePreview[\s\S]*images=\{attachedImages\.map\(\(image\) => image\.previewUrl\)\}[\s\S]*initialIndex=\{i\}/);
  assert.match(messageSource, /<ImagePreview[\s\S]*images=\{imageSources\}[\s\S]*initialIndex=\{index\}/);
  assert.match(sidekickSource, /<ImagePreview[\s\S]*images=\{imageSources\}[\s\S]*initialIndex=\{index\}/);
  assert.match(messageSource, /const resultImages = resultContent\.filter/);
  assert.match(source, /activateNativeImagePreview/);
  assert.match(source, /deactivateNativeImagePreview/);
});
