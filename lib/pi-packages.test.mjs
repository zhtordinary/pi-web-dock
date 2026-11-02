import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { load } from "js-yaml";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const packageLock = require("../package-lock.json");

// pi's packages depend on each other with `^` ranges, and an install of the
// published pi-web resolves them afresh: package-lock.json is not published.
// So every pi package in the tree is a direct dependency at the exact version
// locked here, which npm reuses for the SDK's own ranges. pi-web 0.12.0 pinned
// only four of them, and installs after pi 1.2.0 came out paired
// pi-coding-agent 1.1.0 with pi-codemode 1.2.0, which it cannot load.
const PI_SCOPE = "@earendil-works/";

test("Reader's package and lockfile identify version 0.13.0 consistently", () => {
  assert.equal(packageJson.version, "0.13.0");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
});

test("the pnpm lockfile declares the same exact Pi package versions", () => {
  const lock = load(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
  const dependencies = lock.importers["."].dependencies;
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (!name.startsWith(PI_SCOPE)) continue;
    assert.equal(dependencies[name]?.specifier, version, name);
    const resolved = String(dependencies[name]?.version ?? "");
    assert.ok(resolved === version || resolved.startsWith(`${version}(`), `${name} resolved to ${resolved}`);
  }
});

test("every pi package in the tree is a direct dependency pinned to its locked version", () => {
  const nameOf = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const locked = Object.entries(packageLock.packages).filter(([path]) => nameOf(path).startsWith(PI_SCOPE));
  assert.ok(locked.length > 0, "the lockfile holds pi packages");
  for (const [path, entry] of locked) {
    const name = nameOf(path);
    assert.equal(path, `node_modules/${name}`, `${path}: a second copy of ${name}`);
    assert.equal(packageJson.dependencies[name], entry.version, `${name} must be a dependency pinned to ${entry.version}`);
  }
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (!name.startsWith(PI_SCOPE)) continue;
    assert.equal(packageLock.packages[`node_modules/${name}`]?.version, version, `${name} is pinned but not locked at ${version}`);
  }
});
