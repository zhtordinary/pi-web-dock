import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ExplorerSection.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");

test("provides a debounced file search UI and opens selected results", () => {
  assert.match(source, /searchQuery/);
  assert.match(source, /file-index\?cwd=\$\{encodeURIComponent\(explorerCwd\)\}&q=\$\{encodeURIComponent\(q\)\}/);
  assert.match(source, /setTimeout\(\(\) =>/);
  assert.match(source, /onOpenFile/);
});

test("renders search results with the existing expandable file tree", () => {
  assert.match(source, /buildFileSearchTree/);
  assert.match(source, /visibleSearchTree/);
});

test("search result rows offer mention and download actions like the file tree", () => {
  assert.match(source, /onAtMention/);
});

test("keeps search on the bounded index and reports request failures", () => {
  assert.match(source, /setSearchError/);
  assert.doesNotMatch(apiSource, /type === "search"|searchFiles/);
});
