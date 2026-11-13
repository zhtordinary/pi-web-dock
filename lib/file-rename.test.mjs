import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { renamePathNoClobberSync } from "./file-rename.ts";

const SUBJECT = fileURLToPath(new URL("./file-rename.ts", import.meta.url));
const WRITE_FILE = `
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.argv[1], "created-by-other-process\\n", { flag: "wx" });
`;
const WRITE_DIRECTORY = `
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(process.argv[1]);
  writeFileSync(join(process.argv[1], "created.txt"), "created-by-other-process\\n");
`;
const RENAME = `
  const { renamePathNoClobberSync } = await import(process.argv[1]);
  try {
    renamePathNoClobberSync(process.argv[2], process.argv[3]);
    process.exit(0);
  } catch (error) {
    if (error?.code === "EEXIST") process.exit(17);
    console.error(error);
    process.exit(1);
  }
`;

function runRename(source, target) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      RENAME,
      SUBJECT,
      source,
      target,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stderr }));
  });
}

function temporaryRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("renames symbolic links, including dangling links, without changing their targets", (t) => {
  const root = temporaryRoot("pi-web-rename-link-");
  try {
    const source = join(root, "link");
    const target = join(root, "renamed");
    writeFileSync(join(root, "file.txt"), "unchanged");
    try { symlinkSync("file.txt", source); } catch (error) {
      if (error?.code === "EPERM") return t.skip("Creating symbolic links requires additional privileges");
      throw error;
    }
    renamePathNoClobberSync(source, target);
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(readlinkSync(target), "file.txt");
    assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "unchanged");
    symlinkSync("missing.txt", source);
    assert.throws(() => renamePathNoClobberSync(source, target), (error) => error?.code === "EEXIST");
    rmSync(target);
    renamePathNoClobberSync(source, target);
    assert.equal(readlinkSync(target), "missing.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not clobber a file created by another process in the reservation window", () => {
  const root = temporaryRoot("pi-web-rename-file-race-");
  try {
    const source = join(root, "source.txt");
    const target = join(root, "target.txt");
    writeFileSync(source, "source-content\\n");

    assert.throws(
      () => renamePathNoClobberSync(source, target, {
        beforeReservation: () => {
          const result = spawnSync(process.execPath, ["--input-type=module", "-e", WRITE_FILE, target], { encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
        },
      }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(readFileSync(source, "utf8"), "source-content\\n");
    assert.equal(readFileSync(target, "utf8"), "created-by-other-process\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not clobber a directory created by another process in the reservation window", () => {
  const root = temporaryRoot("pi-web-rename-directory-race-");
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "source.txt"), "source-content\\n");

    assert.throws(
      () => renamePathNoClobberSync(source, target, {
        beforeReservation: () => {
          const result = spawnSync(process.execPath, ["--input-type=module", "-e", WRITE_DIRECTORY, target], { encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
        },
      }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(existsSync(join(source, "source.txt")), true);
    assert.equal(readFileSync(join(target, "created.txt"), "utf8"), "created-by-other-process\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a directory reservation replaced before the final rename", () => {
  const root = temporaryRoot("pi-web-rename-directory-replaced-");
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "source.txt"), "source-content\n");

    assert.throws(
      () => renamePathNoClobberSync(source, target, {
        afterReservation: () => {
          rmSync(target, { recursive: true, force: true });
          mkdirSync(target);
          writeFileSync(join(target, "created.txt"), "created-by-other-process\n");
        },
      }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(existsSync(join(source, "source.txt")), true);
    assert.equal(readFileSync(join(target, "created.txt"), "utf8"), "created-by-other-process\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory fallback moves contents without replacing the destination", () => {
  const root = temporaryRoot("pi-web-rename-directory-fallback-");
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "source.txt"), "source-content\n");
    renamePathNoClobberSync(source, target, { forceFallback: true });
    assert.equal(readFileSync(join(target, "source.txt"), "utf8"), "source-content\n");
    assert.equal(existsSync(source), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory fallback copies nested read-only trees before restoring modes", () => {
  const root = temporaryRoot("pi-web-rename-directory-readonly-");
  const source = join(root, "source");
  const nested = join(source, "nested");
  const target = join(root, "target");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "note.txt"), "read-only-content\n");
  chmodSync(nested, 0o555);
  try {
    renamePathNoClobberSync(source, target, { forceFallback: true });
    assert.equal(readFileSync(join(target, "nested", "note.txt"), "utf8"), "read-only-content\n");
    assert.equal(statSync(join(target, "nested")).mode & 0o777, 0o555);
    assert.equal(existsSync(source), false);
  } finally {
    if (existsSync(join(source, "nested"))) chmodSync(join(source, "nested"), 0o700);
    if (existsSync(join(target, "nested"))) chmodSync(join(target, "nested"), 0o700);
    spawnSync("chmod", ["-R", "u+rwX", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("file rename preserves the source when a linked target is replaced", () => {
  const root = temporaryRoot("pi-web-rename-file-link-replaced-");
  try {
    const source = join(root, "source.txt");
    const target = join(root, "target.txt");
    writeFileSync(source, "source-content\n");
    assert.throws(() => renamePathNoClobberSync(source, target, {
      afterFileLink: () => {
        rmSync(target, { force: true });
        writeFileSync(target, "created-by-other-process\n");
      },
    }), (error) => error?.code === "EEXIST");
    assert.equal(readFileSync(source, "utf8"), "source-content\n");
    assert.equal(readFileSync(target, "utf8"), "created-by-other-process\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory fallback preserves an empty committed target", () => {
  const root = temporaryRoot("pi-web-rename-directory-empty-target-");
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    renamePathNoClobberSync(source, target, { forceFallback: true });
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent file renames have one winner and never overwrite the winner", async () => {
  const root = temporaryRoot("pi-web-rename-file-concurrent-");
  try {
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    const target = join(root, "target.txt");
    writeFileSync(first, "first\\n");
    writeFileSync(second, "second\\n");

    const results = await Promise.all([runRename(first, target), runRename(second, target)]);
    assert.deepEqual(results.map(({ status }) => status).sort((a, b) => a - b), [0, 17]);
    assert.equal(["first\\n", "second\\n"].includes(readFileSync(target, "utf8")), true);
    assert.equal(existsSync(first) || existsSync(second), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory fallback restores the source when an independent writer replaces its reservation", () => {
  const root = temporaryRoot("pi-web-rename-directory-fallback-race-");
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "source.txt"), "source-content\n");
    assert.throws(
      () => renamePathNoClobberSync(source, target, {
        forceFallback: true,
        afterReservation: () => {
          rmSync(target, { recursive: true, force: true });
          mkdirSync(target);
          writeFileSync(join(target, "created.txt"), "created-by-other-process\n");
        },
      }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(readFileSync(join(source, "source.txt"), "utf8"), "source-content\n");
    assert.equal(readFileSync(join(target, "created.txt"), "utf8"), "created-by-other-process\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("directory fallback rolls back every copied child when reservation is replaced mid-copy", () => {
  const root = temporaryRoot("pi-web-rename-directory-mid-copy-replaced-");
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "a.txt"), "source-a\n");
    writeFileSync(join(source, "b.txt"), "source-b\n");

    assert.throws(
      () => renamePathNoClobberSync(source, target, {
        forceFallback: true,
        afterChildMove: (relativePath) => {
          if (relativePath !== "a.txt") return;
          rmSync(target, { recursive: true, force: true });
          mkdirSync(target);
          writeFileSync(join(target, "created.txt"), "created-by-other-process\n");
        },
      }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "source-a\n");
    assert.equal(readFileSync(join(source, "b.txt"), "utf8"), "source-b\n");
    assert.equal(readFileSync(join(target, "created.txt"), "utf8"), "created-by-other-process\n");
    assert.equal(existsSync(join(target, "a.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory fallback rolls back copied children without unlinking a mid-copy collision", () => {
  const root = temporaryRoot("pi-web-rename-directory-mid-copy-collision-");
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "a.txt"), "source-a\n");
    writeFileSync(join(source, "b.txt"), "source-b\n");

    assert.throws(
      () => renamePathNoClobberSync(source, target, {
        forceFallback: true,
        afterChildMove: (relativePath) => {
          if (relativePath !== "a.txt") return;
          writeFileSync(join(target, "b.txt"), "created-by-other-process\n", { flag: "wx" });
        },
      }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "source-a\n");
    assert.equal(readFileSync(join(source, "b.txt"), "utf8"), "source-b\n");
    assert.equal(readFileSync(join(target, "b.txt"), "utf8"), "created-by-other-process\n");
    assert.equal(existsSync(join(target, "a.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent directory renames have one winner and preserve the loser", async () => {
  const root = temporaryRoot("pi-web-rename-directory-concurrent-");
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const target = join(root, "target");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "winner.txt"), "first\\n");
    writeFileSync(join(second, "winner.txt"), "second\\n");

    const results = await Promise.all([runRename(first, target), runRename(second, target)]);
    assert.deepEqual(results.map(({ status }) => status).sort((a, b) => a - b), [0, 17]);
    assert.equal(["first\\n", "second\\n"].includes(readFileSync(join(target, "winner.txt"), "utf8")), true);
    assert.equal(existsSync(first) || existsSync(second), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
