import assert from "node:assert/strict";
import test from "node:test";

import { addHtmlPreviewBase } from "./html-preview.ts";

test("adds Reader resource base inside an existing head", () => {
  const html = "<!doctype html><html><head><title>Demo</title></head><body>ok</body></html>";
  const result = addHtmlPreviewBase(html, "/api/html-preview/session-1/repo/book/");

  assert.ok(result.includes('<head><base href="/api/html-preview/session-1/repo/book/"><title>'));
  assert.equal((result.match(/<base\b/gi) ?? []).length, 1);
});

test("creates head when srcDoc has no head", () => {
  const result = addHtmlPreviewBase("<body><img src=\"assets/a.png\"></body>", "/api/html-preview/_/repo/");

  assert.match(result, /^<head><base href="\/api\/html-preview\/_\/repo\/">/);
});

test("does not add a second base element", () => {
  const html = "<html><head><base href=\"custom/\"></head><body></body></html>";
  assert.equal(addHtmlPreviewBase(html, "/api/html-preview/_/repo/"), html);
});

test("escapes a resource base as an attribute", () => {
  const result = addHtmlPreviewBase("<html></html>", "/api/html-preview/_/repo/?x=\"&");

  assert.match(result, /href="\/api\/html-preview\/_\/repo\/\?x=&quot;&amp;">/);
});
