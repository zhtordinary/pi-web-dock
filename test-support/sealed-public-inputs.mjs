import assert from "node:assert/strict";
import { lstatSync, writeSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, symlink, utimes, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentPiPackage } from "./current-pi-package.mjs";
const fixtureRoot = fileURLToPath(new URL("../test-fixtures/shared-pricing/", import.meta.url));
const ENV_KEYS = ["HOME", "TMPDIR", ...(process.platform === "win32" ? ["USERPROFILE", "TEMP", "TMP"] : []), "XDG_CACHE_HOME", "PI_CONVERSATION_COST_SCRIPT", "PI_GENAI_PRICES_CLI", "PI_GENAI_PRICES_NODE", "PI_CODING_AGENT_DIR"];

async function sha256(filePath) { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }

export async function verifySharedPricingFixture() {
  const content = await readFile(join(fixtureRoot, "manifest.json"), "utf8");
  let manifest;
  try { manifest = JSON.parse(content); }
  catch (error) { throw new Error("Invalid shared pricing fixture manifest", { cause: error }); }
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.role, "Reader test-only frozen public pricing inputs; not production pricing truth");
  for (const entry of manifest.files) {
    const filePath = join(fixtureRoot, entry.path);
    const data = await readFile(filePath);
    assert.equal(data.byteLength, entry.bytes, entry.path);
    assert.equal(await sha256(filePath), entry.sha256, entry.path);
  }
  return manifest;
}

export async function createSealedPublicInputEnvironment(label = "test") {
  const manifest = await verifySharedPricingFixture();
  const root = await mkdtemp(join(tmpdir(), `pi-web-sealed-${label}-`));
  console.log(`[sealed-public-fixture] ${root}`);
  process.once("exit", () => {
    try {
      lstatSync(root);
      writeSync(2, `[sealed-public-fixture-exit-present] ${root}\n`);
      process.exitCode = 1;
    } catch (error) {
      if (error?.code === "ENOENT") writeSync(1, `[sealed-public-fixture-exit-absent] ${root}\n`);
      else {
        writeSync(2, `[sealed-public-fixture-exit-unverified] ${root}\n`);
        process.exitCode = 1;
      }
    }
  });
  const home = join(root, "home");
  const temp = join(root, "tmp");
  const cacheRoot = join(root, "cache");
  const agentDir = join(root, "agent");
  const cacheDir = join(cacheRoot, "pi-sync-maintenance");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(temp, { recursive: true });
  const cachePath = join(cacheDir, "genai-prices-v2.json");
  await copyFile(join(fixtureRoot, "data/genai-prices-v2.json"), cachePath);
  const fresh = new Date(Date.now());
  await utimes(cachePath, fresh, fresh);
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.TMPDIR = temp;
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
    process.env.TEMP = temp;
    process.env.TMP = temp;
  }
  process.env.XDG_CACHE_HOME = cacheRoot;
  process.env.PI_CONVERSATION_COST_SCRIPT = join(fixtureRoot, "scripts/session_cost.py");
  process.env.PI_GENAI_PRICES_CLI = join(fixtureRoot, "genai-prices/cli.cjs");
  process.env.PI_GENAI_PRICES_NODE = process.execPath;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let restored = false;
  return {
    fixtureRoot, manifest, root, home, cacheRoot, cachePath, agentDir,
    scriptPath: process.env.PI_CONVERSATION_COST_SCRIPT,
    cliPath: process.env.PI_GENAI_PRICES_CLI,
    async linkInstalledPiSubagents(targetAgentDir = agentDir) {
      const { packageRoot } = currentPiPackage("pi-subagents");
      const packageDir = join(targetAgentDir, "npm", "node_modules");
      await mkdir(packageDir, { recursive: true });
      const target = join(packageDir, "pi-subagents");
      await symlink(packageRoot, target, "dir");
      return { packageRoot: await realpath(packageRoot), target };
    },
    async restore() {
      if (restored) return;
      restored = true;
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
      try {
        await lstat(root);
        throw new Error("Sealed public fixture still exists after cleanup");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      console.log(`[sealed-public-fixture-cleaned] ${root}`);
    },
  };
}

export async function loadCurrentNativeDiscovery() {
  const snapshot = currentPiPackage("pi-subagents");
  const nativePath = join(snapshot.packageRoot, "src/agents/agents.js");
  const fingerprint = await sha256(nativePath);
  const native = await import(pathToFileURL(nativePath).href);
  assert.equal(typeof native.discoverAgents, "function");
  assert.equal(typeof native.clearAgentDiscoveryCache, "function");
  console.log(`Current ${snapshot.name}@${snapshot.version}: native discovery sha256=${fingerprint}`);
  return { native, ...snapshot, nativePath, fingerprint };
}

export { fixtureRoot };
