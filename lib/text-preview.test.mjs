import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");
const { readTextPreviewChunk } = await jiti.import("./text-preview.ts");

function tempFile(t, name, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, name);
  writeFileSync(filePath, contents);
  return filePath;
}

test("reads large text in contiguous UTF-8 chunks", (t) => {
  const content = "a".repeat(TEXT_PREVIEW_MAX_BYTES - 1) + "😀tail";
  const filePath = tempFile(t, "large.txt", content);
  const size = Buffer.byteLength(content);

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.binary, false);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, TEXT_PREVIEW_MAX_BYTES - 1);
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, size);
});

test("invalid UTF-8 cannot stall pagination", (t) => {
  const filePath = tempFile(t, "binary.txt", Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 0x80));

  const chunk = readTextPreviewChunk(filePath, TEXT_PREVIEW_MAX_BYTES + 1, 0);

  assert.equal(chunk.binary, false);
  assert.equal(chunk.nextOffset, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(chunk.truncated, true);
});

test("a NUL byte in the first block reports binary instead of decoding it", (t) => {
  const contents = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41, 0x42]);
  const filePath = tempFile(t, "archive.bin", contents);

  const chunk = readTextPreviewChunk(filePath, contents.length, 0);

  assert.deepEqual(chunk, { content: "", nextOffset: 0, truncated: false, binary: true });
});

test("a NUL byte past the sniff window stays text", (t) => {
  const contents = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0x00])]);
  const filePath = tempFile(t, "late-nul.txt", contents);

  const chunk = readTextPreviewChunk(filePath, contents.length, 0);

  assert.equal(chunk.binary, false);
  assert.equal(chunk.content.length, contents.length);
});

test("a UTF-16 byte order mark keeps the text view", (t) => {
  const contents = Buffer.from("\ufeffhello", "utf16le");
  const filePath = tempFile(t, "utf16.txt", contents);

  const chunk = readTextPreviewChunk(filePath, contents.length, 0);

  assert.equal(chunk.binary, false);
  assert.equal(chunk.nextOffset, contents.length);
});

test("later offsets of an already accepted text file are never re-sniffed", (t) => {
  const contents = Buffer.concat([Buffer.alloc(TEXT_PREVIEW_MAX_BYTES, 0x61), Buffer.from([0x00])]);
  const filePath = tempFile(t, "tail-nul.txt", contents);

  const second = readTextPreviewChunk(filePath, contents.length, TEXT_PREVIEW_MAX_BYTES);

  assert.equal(second.binary, false);
});
