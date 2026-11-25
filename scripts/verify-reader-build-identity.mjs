import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = process.argv[2] || ".next";
const buildId = readFileSync(join(root, "BUILD_ID"), "utf8").trim();
assert.match(buildId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
const server = readFileSync(join(root, "server/app/api/reader/events/route.js"), "utf8");
const serverIds = [...server.matchAll(/buildId:"([0-9a-f-]{36})"/g)].map(match => match[1]);
assert.ok(serverIds.length > 0, "runtime identity missing from compiled server");
assert.ok(serverIds.every(id => id === buildId), "server runtime identity differs from BUILD_ID");
const pages = readdirSync(join(root, "static/chunks/app")).filter(name => /^page-.*\.js$/.test(name));
assert.ok(pages.length > 0, "browser page bundle missing");
assert.ok(pages.some(name => readFileSync(join(root, "static/chunks/app", name), "utf8").includes(JSON.stringify(buildId))), "browser bundle identity differs from BUILD_ID");

// Exercise the actual compiled route: its bundler can rewrite native imports differently from Jiti.
const home = mkdtempSync(join(tmpdir(), "pi-web-build-smoke-"));
try {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("PI_") || /(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name)) delete process.env[name];
  }
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), PI_CODING_AGENT_DIR: join(home, "agent") });
  const require = createRequire(import.meta.url);
  require(resolve(root, "server/app/api/agent/[id]/route.js"));
  const runtime = require(resolve(root, "server/webpack-runtime.js"));
  const adapters = Object.entries(runtime.m).filter(([, factory]) => Function.prototype.toString.call(factory).includes("Pi Codex cache-affinity adapter was not loaded"));
  assert.equal(adapters.length, 1, "compiled Codex cache-affinity adapter missing or ambiguous");
  const { loadCodexAffinityAdapter } = runtime(adapters[0][0]);
  assert.equal((await loadCodexAffinityAdapter()).readerCacheAffinity, true);
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ buildId, server: "matched", browser: "matched", codexAffinity: "loaded" }));
