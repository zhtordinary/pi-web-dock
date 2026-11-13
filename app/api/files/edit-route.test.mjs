import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("file edit route uses bounded optimistic-concurrency writes", () => {
  assert.match(source, /export async function PUT\(/);
  assert.match(source, /readJsonWithinLimit\(request, MAX_EDIT_REQUEST_BYTES\)/);
  assert.match(source, /Buffer\.byteLength\(body\.content, "utf8"\) > TEXT_EDIT_MAX_BYTES/);
  assert.match(source, /stat\.size > TEXT_EDIT_MAX_BYTES/);
  assert.match(source, /hasParentDirectorySegment\(filePath\)/);
  assert.match(source, /body\.version !== fileVersion\(stat\)/);
  assert.match(source, /status: 409/);
  assert.match(source, /writeTextFileAtomicSync\(filePath, body\.content\)/);
});

test("text reads expose edit capability and snapshot version", () => {
  assert.match(source, /version: fileVersion\(stat\)/);
  assert.match(source, /editable: !chunk.binary && \(offset === 0 \|\| !isBinaryTextFile/);
});
