import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { SUPPORTED_VERSION, RELATIVE_FILE, PATCH_MARKER, OLD_TEXT, NEW_TEXT,
  piAiPackageRoot, patchPiCodexCacheRoute } = require("../bin/patch-pi-codex-cache-route.cjs");

function fixture(t, version = SUPPORTED_VERSION, source = OLD_TEXT) {
  const root = mkdtempSync(join(tmpdir(), "reader-codex-route-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, RELATIVE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(file, source);
  return { root, file };
}

test("patches the pinned Codex transport once and verifies the existing patch", (t) => {
  const { root, file } = fixture(t);
  assert.equal(patchPiCodexCacheRoute(root), 1);
  assert.equal(readFileSync(file, "utf8"), NEW_TEXT);
  assert.equal(patchPiCodexCacheRoute(root), 0);
  writeFileSync(file, `${NEW_TEXT}\n${PATCH_MARKER}`);
  assert.throws(() => patchPiCodexCacheRoute(root), /Cannot verify/);
});

test("refuses an unknown version or changed transport", (t) => {
  const version = fixture(t, "99.0.0");
  assert.throws(() => patchPiCodexCacheRoute(version.root), /patch expected/);
  const changed = fixture(t, SUPPORTED_VERSION, "unexpected implementation");
  assert.throws(() => patchPiCodexCacheRoute(changed.root), /expected one match/);
  const duplicate = fixture(t, SUPPORTED_VERSION, `${OLD_TEXT}\n${OLD_TEXT}`);
  assert.throws(() => patchPiCodexCacheRoute(duplicate.root), /expected one match/);
});

test("postinstall patches the exact locked Pi AI transport", () => {
  const root = piAiPackageRoot();
  const installed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const app = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(installed.version, app.dependencies["@earendil-works/pi-ai"]);
  assert.equal(installed.version, SUPPORTED_VERSION);
  const source = readFileSync(join(root, RELATIVE_FILE), "utf8");
  assert.equal(source.split(PATCH_MARKER).length - 1, 1);
  assert.equal(source.split(NEW_TEXT).length - 1, 1);
});
