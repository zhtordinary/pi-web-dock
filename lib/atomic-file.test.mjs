import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

const { directoryOpenMode, writePrivateFileAtomicSync, UnresolvableLinkError } = await import("./atomic-file.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-atomic-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("directory sync keeps POSIX mode, uses writable Windows mode, and preserves real failures", (t) => {
  assert.equal(directoryOpenMode("linux"), "r");
  assert.equal(directoryOpenMode("darwin"), "r");
  assert.equal(directoryOpenMode("win32"), "r+");

  const root = createTempRoot(t);
  const originalSync = fs.fsyncSync;
  let failureCode = "EIO";
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error(`directory ${failureCode}`), { code: failureCode });
    return originalSync(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const code of ["EIO", "EPERM"]) {
    failureCode = code;
    const destination = path.join(root, `${code}.json`);
    fs.writeFileSync(destination, "old");
    assert.throws(() => writePrivateFileAtomicSync(destination, "new"), { code });
    assert.equal(fs.readFileSync(destination, "utf8"), "new");
  }
  assert.deepEqual(fs.readdirSync(root).sort(), ["EIO.json", "EPERM.json"]);
});

test("exclusive-create collisions preserve the existing temporary file and destination", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "collision.json");
  const temporary = path.join(root, ".collision.json-collision.tmp");
  fs.writeFileSync(destination, "old");
  fs.writeFileSync(temporary, "pre-existing");
  t.mock.method(crypto, "randomUUID", () => "collision");
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"), { code: "EEXIST" });
  assert.equal(fs.readFileSync(temporary, "utf8"), "pre-existing");
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
});

test("cleans its temporary file if writing fails after exclusive creation", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "write-failure.json");
  fs.writeFileSync(destination, "old");
  const writeFile = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (typeof file === "number") throw Object.assign(new Error("write failed"), { code: "ENOSPC" });
    return writeFile(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"), { code: "ENOSPC" });
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(root), ["write-failure.json"]);
});

test("a failed temporary-file sync preserves the destination and cleans the temporary file", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "sync-failure.json");
  fs.writeFileSync(destination, "old");
  const sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.fstatSync(fd).isFile()) throw Object.assign(new Error("file sync failed"), { code: "EIO" });
    return sync(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"), { code: "EIO" });
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(root), ["sync-failure.json"]);
});

test("reports both write and close failures without replacing the destination", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "close-failure.json");
  fs.writeFileSync(destination, "old");
  const writeFile = fs.writeFileSync;
  const close = fs.closeSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (typeof file === "number") throw Object.assign(new Error("write failed"), { code: "ENOSPC" });
    return writeFile(file, ...args);
  });
  t.mock.method(fs, "closeSync", (fd) => {
    close(fd);
    throw Object.assign(new Error("close failed"), { code: "EIO" });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"), (error) =>
    error instanceof AggregateError && error.errors[0]?.code === "ENOSPC" && error.errors[1]?.code === "EIO");
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(root), ["close-failure.json"]);
});

test("does not remove a new file created at the old temporary name after rename", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "renamed.json");
  const rename = fs.renameSync;
  let temporary;
  t.mock.method(fs, "renameSync", (source, target) => {
    rename(source, target);
    temporary = source;
    fs.writeFileSync(source, "new owner");
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  writePrivateFileAtomicSync(destination, "new");
  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.equal(fs.readFileSync(temporary, "utf8"), "new owner");
});

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
