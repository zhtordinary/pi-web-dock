import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { isExistingDirectory } = await jiti.import("./file-access.ts");
const { hasParentDirectorySegment, isExistingPathWithinRoots } = await jiti.import("./path-security.ts");

test("checks directory existence without a permission list", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reader-directory-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "project"));
  fs.writeFileSync(path.join(root, "file"), "fixture");
  assert.equal(isExistingDirectory(path.join(root, "project")), true);
  assert.equal(isExistingDirectory(path.join(root, "file")), false);
  assert.equal(isExistingDirectory(path.join(root, "missing")), false);
});

test("explicit project scope comparisons still resolve links and reject parent segments", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reader-scope-check-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(isExistingPathWithinRoots(path.join(project, "link"), new Set([project])), false);
  assert.equal(hasParentDirectorySegment("/a/b/../c"), true);
  assert.equal(hasParentDirectorySegment("/a/..b/c.."), false);
});
