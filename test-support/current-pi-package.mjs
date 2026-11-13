import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export function currentPiPackage(name, {
  agentDir = process.env.READER_TEST_PI_AGENT_DIR,
  manifestPath = process.env.READER_TEST_PI_PACKAGE_MANIFEST,
} = {}) {
  assert.ok(typeof agentDir === "string" && isAbsolute(agentDir), "READER_TEST_PI_AGENT_DIR must identify the current Pi installation");
  assert.ok(typeof manifestPath === "string" && isAbsolute(manifestPath), "READER_TEST_PI_PACKAGE_MANIFEST must identify the shared package declaration");
  assert.match(name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i, "invalid package name");
  const declared = JSON.parse(readFileSync(manifestPath, "utf8")).dependencies?.[name];
  assert.match(declared ?? "", /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i, `${name} must have an exact current shared declaration`);
  const nodeModules = realpathSync(join(agentDir, "npm", "node_modules"));
  const packageRoot = realpathSync(join(nodeModules, name));
  const location = relative(nodeModules, packageRoot);
  assert.ok(location && location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location), `${name} must resolve inside the current Pi installation`);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, name, "installed package identity differs from the declaration");
  assert.equal(manifest.version, declared, `${name} installation differs from the current shared declaration`);
  return { name, version: manifest.version, packageRoot, nodeModules };
}
