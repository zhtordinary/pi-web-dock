import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("HTML preview resources follow operating-system permissions", () => {
  assert.doesNotMatch(source, /getAllowedFileRoots|isFilePathAllowed|isFilePathReferencedBySession/);
  assert.match(source, /Invalid HTML preview resource path/);
});

test("HTML preview resources are bounded and served inline without sniffing", () => {
  assert.match(source, /MAX_RESOURCE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(source, /"Content-Disposition": "inline"/);
  assert.match(source, /"X-Content-Type-Options": "nosniff"/);
  assert.match(source, /"Cache-Control": "no-cache"/);
});

test("nested HTML resources remain sandboxed", () => {
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /sandbox allow-scripts allow-popups/);
  assert.doesNotMatch(source, /allow-same-origin/);
});

test("HTML preview supports scripts, styles, images, fonts, and common data files", () => {
  for (const extension of ["html", "css", "js", "json", "wasm", "woff2"]) {
    assert.match(source, new RegExp(`${extension}:`));
  }
  assert.match(source, /getImageMime/);
});

test("invalid or unsupported preview resources fail closed", () => {
  assert.match(source, /Invalid HTML preview resource path/);
  assert.match(source, /Preview resource type not supported/);
  assert.match(source, /status: 415/);
});
