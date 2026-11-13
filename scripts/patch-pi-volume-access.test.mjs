import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PATCHES, SUPPORTED_VERSIONS, patchPiFileTools, piPackageRoot } = require("../bin/patch-pi-volume-access.cjs");

test("patches Pi 1.5 file preflights without widening real filesystem operations", () => {
  const root = mkdtempSync(join("/tmp", "reader-pi-volume-patch-"));
  try {
    mkdirSync(join(root, "dist/core/tools"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.5.0" }));
    for (const patch of PATCHES) {
      writeFileSync(join(root, patch.relative), patch.oldText);
    }

    assert.equal(patchPiFileTools(root), PATCHES.length);
    for (const patch of PATCHES) {
      const patched = readFileSync(join(root, patch.relative), "utf8");
      assert.ok(patched.includes(patch.marker), patch.marker);
      assert.equal(patched, patch.newText);
    }
    assert.equal(patchPiFileTools(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installed pinned Pi version has every file preflight patched", () => {
  const root = piPackageRoot();
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const app = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, app.dependencies["@earendil-works/pi-coding-agent"]);
  assert.ok(SUPPORTED_VERSIONS.has(version));
  for (const patch of PATCHES) {
    const source = readFileSync(join(root, patch.relative), "utf8");
    assert.equal(source.split(patch.marker).length - 1, 1, patch.marker);
  }
});

test("refuses an unreviewed Pi coding-agent version", () => {
  const root = mkdtempSync(join("/tmp", "reader-pi-volume-patch-version-"));
  try {
    mkdirSync(join(root, "dist/core/tools"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
    assert.throws(() => patchPiFileTools(root), /expected, found 2\.0\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
