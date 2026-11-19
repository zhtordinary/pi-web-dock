import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { watchDirectory } = await createJiti(import.meta.url).import("./watch-directory.ts");

test("Windows watches the physical directory, while POSIX preserves the input", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-watch-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  const alias = join(root, "alias");
  mkdirSync(target);
  symlinkSync(target, alias, "junction");
  assert.equal(watchDirectory(alias, "win32"), realpathSync.native(target));
  assert.equal(watchDirectory(alias, "linux"), alias);
  assert.throws(() => watchDirectory(join(root, "missing"), "win32"), { code: "ENOENT" });
});

test("Windows expands an 8.3 directory alias before watching", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "reader-watch-short-path-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (process.platform !== "win32") {
    assert.equal(watchDirectory(root), root);
    return;
  }
  const cmd = join(process.env.SystemRoot, "System32", "cmd.exe");
  const alias = execFileSync(cmd, ["/d", "/u", "/v:off", "/s", "/c", 'for %I in ("%READER_TEST_WATCH_ROOT%") do @echo %~sI'], {
    encoding: "utf16le",
    windowsVerbatimArguments: true,
    env: { ...process.env, READER_TEST_WATCH_ROOT: root },
  }).trim();
  assert.notEqual(alias, "");
  assert.equal(relative(realpathSync.native(alias), root), "");
  if (relative(alias, root) === "") t.diagnostic("8.3 aliases unavailable; exercising the physical path");
  assert.equal(relative(watchDirectory(alias), root), "");
});
