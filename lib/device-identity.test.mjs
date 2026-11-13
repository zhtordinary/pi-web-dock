import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const identity = require("../bin/device-identity.cjs");
const keys = ["PI_WEB_SESSION_ACTIVITY_CONFIG", "PI_WEB_SESSION_ACTIVITY_CONFIG_FILE", "PI_WEB_DEVICE_ID", "PI_WEB_DEVICE_NAME",
  "PI_WEB_HIDDEN_FILE", "PI_WEB_FAVORITES_FILE", "PI_CODING_AGENT_DIR"];
function fixture(t) {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), "reader-device-identity-"));
  for (const key of keys) delete process.env[key];
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG_FILE = join(root, "activity.json");
  process.env.PI_WEB_HIDDEN_FILE = join(root, "hidden.json");
  process.env.PI_WEB_FAVORITES_FILE = join(root, "favorites.json");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG_FILE };
}

test("device identity shares config, environment, and hostname precedence with name handling", (t) => {
  const f = fixture(t);
  assert.equal(identity.localDeviceId(), hostname());
  process.env.PI_WEB_DEVICE_ID = "env-device";
  process.env.PI_WEB_DEVICE_NAME = "Environment";
  assert.equal(identity.localDeviceId(), "env-device");
  writeFileSync(f.file, JSON.stringify({ device: { id: "file-device", name: "File" } }));
  assert.equal(identity.localDeviceId(), "file-device");
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "configured-device", name: "Configured" } });
  assert.equal(identity.localDeviceId(), "configured-device");
  assert.equal(identity.localDeviceName(), "Configured");
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "   ", name: " " } });
  assert.equal(identity.localDeviceId(), "env-device");
  assert.equal(identity.localDeviceName(), "Environment");
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = "invalid JSON";
  assert.equal(identity.localDeviceId(), "file-device", "invalid inline configuration consistently falls back to file");
});

test("unchanged file configuration is parsed once and explicit updates invalidate without a TTL", (t) => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ device: { id: "device-a" } }));
  const originalRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (...args) => {
    if (args[0] === f.file) reads++;
    return originalRead(...args);
  });
  for (let index = 0; index < 100; index++) assert.equal(identity.localDeviceId(), "device-a");
  assert.equal(reads, 1);
  assert.throws(() => { identity.readActivityConfig().device.id = "uncommitted"; }, TypeError);
  assert.equal(identity.localDeviceId(), "device-a", "callers cannot mutate the cached configuration");
  const before = statSync(f.file);
  // Coarse filesystem clocks stamp writes within one tick identically; wait for
  // the next tick so the replacement below really carries a newer ctime.
  const tick = join(f.root, "tick");
  const deadline = Date.now() + 2_000;
  do writeFileSync(tick, ""); while (statSync(tick).ctimeMs <= before.ctimeMs && Date.now() < deadline);
  assert.ok(statSync(tick).ctimeMs > before.ctimeMs, "filesystem ctime did not advance");
  writeFileSync(f.file, JSON.stringify({ device: { id: "device-b" } }));
  utimesSync(f.file, before.atime, before.mtime);
  assert.equal(identity.localDeviceId(), "device-b", "same-sized replacement with restored mtime changes ctime");
  const replacement = join(f.root, "replacement.json");
  writeFileSync(replacement, JSON.stringify({ device: { id: "device-c" } }));
  renameSync(replacement, f.file);
  assert.equal(identity.localDeviceId(), "device-c");
  process.env.PI_WEB_DEVICE_ID = "environment-fallback";
  writeFileSync(f.file, "broken");
  assert.equal(identity.localDeviceId(), "environment-fallback");
  rmSync(f.file);
  assert.equal(identity.localDeviceId(), "environment-fallback");
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG_FILE = replacement;
  writeFileSync(replacement, JSON.stringify({ device: { id: "other-path" } }));
  assert.equal(identity.localDeviceId(), "other-path");
});

test("Activity and Talk Map share configured business identity", async (t) => {
  const f = fixture(t);
  process.env.PI_WEB_DEVICE_ID = "ignored-env-device";
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "configured-device", name: "Configured", url: "http://localhost" } });
  writeFileSync(process.env.PI_WEB_HIDDEN_FILE, JSON.stringify({ devices: ["configured-device"] }));
  const session = join(f.root, "session.jsonl");
  writeFileSync(session, JSON.stringify({ type: "session", id: "fixture", cwd: f.root }) + "\n");
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const activity = await jiti.import("./activity-peers.ts");
  const talkMap = await jiti.import("./talk-map.ts");
  assert.equal(activity.localDeviceIdentity(activity.readActivityConfig(), "now").id, "configured-device");
  assert.equal(talkMap.createEmptyTalkMap(f.root).deviceId, "configured-device");
  assert.equal(activity.resolvePeerUrl("configured-device"), "http://localhost");
  // No runtime restart is needed to observe an explicit configuration update.
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "updated-device" } });
  assert.equal(activity.localDeviceId(), "updated-device");
  assert.equal(talkMap.createEmptyTalkMap(f.root).deviceId, "updated-device");
  assert.ok(readFileSync(session, "utf8").includes('"id":"fixture"'));
});

test("file open/reveal routing and transient deletion cleanup use the configured identity", async (t) => {
  const f = fixture(t);
  process.env.PI_WEB_DEVICE_ID = "ignored-env-device";
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "configured-device" } });
  writeFileSync(process.env.PI_WEB_HIDDEN_FILE, JSON.stringify({ devices: ["configured-device"] }));
  const previousRoots = globalThis.__piAllowedRootsCache;
  const previousSessions = globalThis.__piSessions;
  globalThis.__piAllowedRootsCache = { roots: new Set([f.root]), expiresAt: Date.now() + 60_000 };
  let shutdowns = 0;
  globalThis.__piSessions = new Map([["transient", { isAlive: () => true, sessionFile: "", cwd: f.root,
    inner: {}, shutdown: async () => { shutdowns++; } }]]);
  t.after(() => { globalThis.__piAllowedRootsCache = previousRoots; globalThis.__piSessions = previousSessions; });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
  for (const endpoint of ["open", "reveal"]) {
    const route = await jiti.import(`../app/api/files/${endpoint}/route.ts`);
    const request = deviceId => new Request(`http://localhost/api/files/${endpoint}`, { method: "POST",
      headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ deviceId, path: "/outside-identity-fixture" }) });
    const response = await route.POST(request("configured-device"));
    assert.equal(response.status, 404, "a missing local path is reported without launching a desktop command");
    assert.equal((await response.json()).error, "Not found");
    assert.equal((await route.POST(request("ignored-env-device"))).status, 404);
  }
  const sessions = await jiti.import("../app/api/sessions/[id]/route.ts");
  const response = await sessions.DELETE(new Request("http://localhost/api/sessions/transient", { method: "DELETE" }),
    { params: Promise.resolve({ id: "transient" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deleted: true });
  assert.equal(shutdowns, 1);
});

test("adding a peer rejects the local device even when its identity comes from the environment", async (t) => {
  const f = fixture(t);
  process.env.PI_WEB_DEVICE_ID = "environment-device";
  writeFileSync(f.file, JSON.stringify({ peers: [] }));
  const before = readFileSync(f.file, "utf8");
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ device: { id: "environment-device", name: "Local" } }),
    { headers: { "content-type": "application/json" } }));
  const route = await createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false }).import("../app/api/peers/route.ts");
  const response = await route.POST(new Request("http://localhost/api/peers", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "http://peer-fixture.invalid" }) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "peer_is_local");
  assert.equal(readFileSync(f.file, "utf8"), before);
});
