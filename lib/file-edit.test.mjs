import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { fileVersion, MAX_EDIT_REQUEST_BYTES, TEXT_EDIT_MAX_BYTES, writeTextFileAtomicSync } = await import("./file-edit.ts");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("keeps edit request bounded below the preview limit", () => {
  assert.equal(TEXT_EDIT_MAX_BYTES, 2 * 1024 * 1024);
  assert.ok(MAX_EDIT_REQUEST_BYTES > TEXT_EDIT_MAX_BYTES);
});

test("atomically replaces text while preserving mode and symlink", (t) => {
  const root = tempRoot(t);
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  fs.writeFileSync(target, "old", { mode: 0o640 });
  fs.symlinkSync(target, link);
  const before = fileVersion(fs.statSync(link));

  writeTextFileAtomicSync(link, "new");

  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(fs.readlinkSync(link), target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.notEqual(fileVersion(fs.statSync(link)), before);
  assert.deepEqual(fs.readdirSync(root).sort(), ["link.txt", "target.txt"]);
});
