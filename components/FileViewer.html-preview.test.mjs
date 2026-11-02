import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("HTML preview resolves relative resources through Reader", () => {
  assert.match(source, /addHtmlPreviewBase/);
  assert.match(source, /htmlPreviewResourceBase/);
  assert.match(source, /srcDoc=\{addHtmlPreviewBase\(content, htmlPreviewResourceBase\(filePath, sourceSessionId, remotePeer\)\)\}/);
  assert.match(source, /key=\{`\$\{filePath\}:\$\{data\?\.version \?\? ""\}`\}/);
});

test("HTML preview keeps script execution sandboxed without same-origin access", () => {
  const start = source.indexOf(") : isHtml && effectiveDisplayMode === \"preview\" ? (");
  const end = source.indexOf(") : isMarkdown && effectiveDisplayMode === \"preview\" ? (", start);
  assert.ok(start >= 0 && end > start);
  const branch = source.slice(start, end);
  assert.match(branch, /sandbox=\"allow-scripts allow-popups\"/);
  assert.doesNotMatch(branch, /allow-same-origin/);
  assert.doesNotMatch(branch, /allow-popups-to-escape-sandbox/);
});
