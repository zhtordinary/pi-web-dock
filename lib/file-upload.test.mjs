import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

test("writes a complete new upload through a private same-directory temporary file", async (t) => {
  const { writeUploadFileAtomicSync } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const destination = path.join(root, "new.txt");
  writeUploadFileAtomicSync(destination, Buffer.from("complete upload"));
  assert.equal(fs.readFileSync(destination, "utf8"), "complete upload");
  assert.deepEqual(fs.readdirSync(root), ["new.txt"]);
});

test("keeps old bytes and removes only this upload temp file when replacement fails", async (t) => {
  const { writeUploadFileAtomicSync } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const destination = path.join(root, "existing.txt");
  fs.writeFileSync(destination, "old complete bytes");
  const originalRename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (path.resolve(String(to)) === path.resolve(destination)) {
      const error = new Error("synthetic replacement failure");
      error.code = "EIO";
      throw error;
    }
    return originalRename(from, to);
  });
  try {
    assert.throws(
      () => writeUploadFileAtomicSync(destination, Buffer.from("new complete bytes"), { replaceExisting: true }),
      /synthetic replacement failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(fs.readFileSync(destination, "utf8"), "old complete bytes");
  assert.deepEqual(fs.readdirSync(root), ["existing.txt"]);
});
