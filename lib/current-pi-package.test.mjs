import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentPiPackage } from "../test-support/current-pi-package.mjs";

test("the current installed plugin follows updates and rejects mismatched declarations", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-current-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const nodeModules = join(agentDir, "npm/node_modules");
  const manifestPath = join(root, "shared-package.json");
  const name = "test-plugin";
  mkdirSync(nodeModules, { recursive: true });
  const install = (version) => {
    const target = join(nodeModules, `.store-${version}`);
    mkdirSync(target);
    writeFileSync(join(target, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(manifestPath, JSON.stringify({ dependencies: { [name]: version } }));
    symlinkSync(target, join(nodeModules, name));
  };
  install("1.0.0");
  assert.equal(currentPiPackage(name, { agentDir, manifestPath }).version, "1.0.0");
  unlinkSync(join(nodeModules, name));
  install("2.0.0");
  assert.equal(currentPiPackage(name, { agentDir, manifestPath }).version, "2.0.0");
  writeFileSync(manifestPath, JSON.stringify({ dependencies: { [name]: "3.0.0" } }));
  assert.throws(() => currentPiPackage(name, { agentDir, manifestPath }), /differs from the current shared declaration/);
  writeFileSync(manifestPath, JSON.stringify({ dependencies: { [name]: "latest" } }));
  assert.throws(() => currentPiPackage(name, { agentDir, manifestPath }), /exact current shared declaration/);
  unlinkSync(join(nodeModules, name));
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "package.json"), JSON.stringify({ name, version: "3.0.0" }));
  writeFileSync(manifestPath, JSON.stringify({ dependencies: { [name]: "3.0.0" } }));
  symlinkSync(outside, join(nodeModules, name));
  assert.throws(() => currentPiPackage(name, { agentDir, manifestPath }), /inside the current Pi installation/);
});
