import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, utimes, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const fixtureRoot = resolve(new URL("../test-fixtures/shared-pricing/", import.meta.url).pathname);
const ENV_KEYS = ["HOME", "XDG_CACHE_HOME", "PI_CONVERSATION_COST_SCRIPT", "PI_GENAI_PRICES_CLI", "PI_GENAI_PRICES_NODE", "PI_CODING_AGENT_DIR"];

async function sha256(filePath) { return createHash("sha256").update(await readFile(filePath)).digest("hex"); }

export async function verifySharedPricingFixture() {
  const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
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
  const home = join(root, "home");
  const cacheRoot = join(root, "cache");
  const agentDir = join(root, "agent");
  const cacheDir = join(cacheRoot, "pi-sync-maintenance");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const cachePath = join(cacheDir, "genai-prices-v2.json");
  await copyFile(join(fixtureRoot, "data/genai-prices-v2.json"), cachePath);
  const fresh = new Date(Date.now());
  await utimes(cachePath, fresh, fresh);
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
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
      const packageEntry = require.resolve("pi-subagents");
      let packageRoot = dirname(packageEntry);
      while (packageRoot !== dirname(packageRoot)) {
        try {
          const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
          if (metadata.name === "pi-subagents") break;
        } catch {}
        packageRoot = dirname(packageRoot);
      }
      assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "0.74.0");
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
    },
  };
}

export async function loadPinnedNativeDiscovery() {
  const packageEntry = require.resolve("pi-subagents");
  let packageRoot = dirname(packageEntry);
  while (packageRoot !== dirname(packageRoot)) {
    try {
      const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      if (metadata.name === "pi-subagents") break;
    } catch {}
    packageRoot = dirname(packageRoot);
  }
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "0.74.0");
  const nativePath = join(packageRoot, "src/agents/agents.js");
  assert.equal(await sha256(nativePath), "064427925d9ef53f985f00452d4e6dfb02ff3906950ee4752f5380489c41e895");
  const native = await import(pathToFileURL(nativePath).href);
  assert.equal(typeof native.discoverAgents, "function");
  assert.equal(typeof native.clearAgentDiscoveryCache, "function");
  return { native, packageRoot, nativePath, packageVersion: "0.74.0" };
}

export { fixtureRoot };
