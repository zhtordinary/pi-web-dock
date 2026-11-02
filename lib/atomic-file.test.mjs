import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { writePrivateFileAtomicSync, UnresolvableLinkError } = await import("./atomic-file.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-atomic-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomically replaces a file with restrictive permissions", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.writeFileSync(destination, "old", { mode: 0o644 });

  writePrivateFileAtomicSync(destination, "new");

  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test("keeps the destination and removes the temporary file when replacement fails", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.mkdirSync(destination);

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"));
  assert.equal(fs.statSync(destination).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
});

test("updates the target without replacing a symlink", (t) => {
  const root = createTempRoot(t);
  const target = path.join(root, "shared", "models.json");
  const link = path.join(root, "models.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "old", { mode: 0o644 });
  fs.symlinkSync(target, link);

  writePrivateFileAtomicSync(link, "new");

  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(fs.readFileSync(link, "utf8"), "new");
  assert.equal(fs.readlinkSync(link), target);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
});

test("refuses a dangling symlink and leaves the link in place", (t) => {
  const root = createTempRoot(t);
  const target = path.join(root, "missing.json");
  const link = path.join(root, "models.json");
  fs.symlinkSync(target, link);

  assert.throws(() => writePrivateFileAtomicSync(link, "new"), UnresolvableLinkError);
  assert.equal(fs.readlinkSync(link), target);
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
});

test("refuses a symlink loop without replacing either link", (t) => {
  const root = createTempRoot(t);
  const link = path.join(root, "models.json");
  const loop = path.join(root, "models-loop");
  fs.symlinkSync(loop, link);
  fs.symlinkSync(link, loop);

  assert.throws(() => writePrivateFileAtomicSync(link, "new"), UnresolvableLinkError);
  assert.equal(fs.readlinkSync(link), loop);
  assert.equal(fs.readlinkSync(loop), link);
  assert.deepEqual(fs.readdirSync(root).sort(), ["models-loop", "models.json"]);
});
