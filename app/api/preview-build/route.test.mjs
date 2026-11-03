import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const routeModule = await jiti.import("./route.ts");
const buildModule = await jiti.import("../reader/build/route.ts");
const { GET } = buildModule;

test("preview route exports only the Next.js GET handler", () => {
  assert.deepEqual(Object.keys(routeModule).sort(), ["GET"]);
  assert.deepEqual(Object.keys(buildModule).sort(), ["GET"]);
  assert.equal(routeModule.GET, GET);
});

function writeIdentity(root, overrides = {}) {
  const artifactSha256 = "a".repeat(64);
  const lockfileSha256 = "b".repeat(64);
  const readerCommit = "c".repeat(40);
  const buildId = "preview-build-1";
  mkdirSync(join(root, ".next"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@zhtordinary/pi-web-dock", version: "0.9.3" }) + "\n");
  writeFileSync(join(root, "bin", "pi-web.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(root, ".next", "BUILD_ID"), `${buildId}\n`);
  writeFileSync(join(root, ".pi-web-reader-release.json"), JSON.stringify({
    schema: 5,
    managedBy: "pi-web-reader-release",
    artifact: "pi-web-reader-0.9.3-reader.tgz",
    artifactBytes: "1234",
    version: "0.9.3",
    artifactSha256,
    lockfileSha256,
    readerCommit,
    buildId,
    installationMode: "production",
    installationPath: root,
    health: "healthy",
    sourceDirty: false,
    ...overrides,
  }));
  return { artifactSha256, lockfileSha256, readerCommit, buildId };
}

test("preview identity binds 30142 to the physical production selector", async (t) => {
  const oldCwd = process.cwd();
  const oldInstall = process.env.PI_WEB_INSTALL_DIR;
  const oldSelector = process.env.PI_WEB_30142_SELECTOR;
  const oldBoundPort = process.env.PI_WEB_BOUND_PORT;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-preview-install-")));
  const install = join(parent, ".local", "share", "pi-web-reader");
  const releases = join(install, "releases");
  const target = join(releases, "artifact-a");
  const selector = join(install, "preview-30142");
  mkdirSync(releases, { recursive: true });
  const identity = writeIdentity(target);
  symlinkSync(target, selector);
  process.env.PI_WEB_INSTALL_DIR = install;
  process.env.PI_WEB_30142_SELECTOR = selector;
  process.env.PI_WEB_BOUND_PORT = "30142";
  process.chdir(target);
  t.after(() => {
    process.chdir(oldCwd);
    if (oldInstall === undefined) delete process.env.PI_WEB_INSTALL_DIR;
    else process.env.PI_WEB_INSTALL_DIR = oldInstall;
    if (oldSelector === undefined) delete process.env.PI_WEB_30142_SELECTOR;
    else process.env.PI_WEB_30142_SELECTOR = oldSelector;
    if (oldBoundPort === undefined) delete process.env.PI_WEB_BOUND_PORT;
    else process.env.PI_WEB_BOUND_PORT = oldBoundPort;
    rmSync(parent, { recursive: true, force: true });
  });

  const found = await (await GET()).json();
  assert.deepEqual(found, {
    channel: "preview",
    schema: 5,
    artifact: "pi-web-reader-0.9.3-reader.tgz",
    artifactBytes: "1234",
    version: "0.9.3",
    readerCommit: identity.readerCommit,
    buildId: identity.buildId,
    artifactSha256: identity.artifactSha256,
    lockfileSha256: identity.lockfileSha256,
    installationPath: target,
  });
  const response = await GET(new Request("http://localhost:30142/api/preview-build"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await response.json()).installationPath, target);
  const pendingMetadata = JSON.parse(await (await import("node:fs/promises")).readFile(join(target, ".pi-web-reader-release.json"), "utf8"));
  pendingMetadata.health = "pending";
  delete pendingMetadata.sourceDirty;
  writeFileSync(join(target, ".pi-web-reader-release.json"), JSON.stringify(pendingMetadata));
  assert.equal((await GET(new Request("http://localhost:30142/api/preview-build"))).status, 200);
});

test("preview identity rejects test/source directories, schema-4 metadata and drift", async (t) => {
  const oldCwd = process.cwd();
  const oldInstall = process.env.PI_WEB_INSTALL_DIR;
  const oldSelector = process.env.PI_WEB_30142_SELECTOR;
  const oldBoundPort = process.env.PI_WEB_BOUND_PORT;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-preview-invalid-")));
  const install = join(parent, ".local", "share", "pi-web-reader");
  const releases = join(install, "releases");
  const target = join(releases, "artifact-b");
  const selector = join(install, "preview-30142");
  mkdirSync(releases, { recursive: true });
  writeIdentity(target);
  symlinkSync(target, selector);
  process.env.PI_WEB_INSTALL_DIR = install;
  process.env.PI_WEB_30142_SELECTOR = selector;
  process.env.PI_WEB_BOUND_PORT = "30142";
  process.chdir(target);
  t.after(() => {
    process.chdir(oldCwd);
    if (oldInstall === undefined) delete process.env.PI_WEB_INSTALL_DIR;
    else process.env.PI_WEB_INSTALL_DIR = oldInstall;
    if (oldSelector === undefined) delete process.env.PI_WEB_30142_SELECTOR;
    else process.env.PI_WEB_30142_SELECTOR = oldSelector;
    if (oldBoundPort === undefined) delete process.env.PI_WEB_BOUND_PORT;
    else process.env.PI_WEB_BOUND_PORT = oldBoundPort;
    rmSync(parent, { recursive: true, force: true });
  });

  writeFileSync(join(target, ".pi-web-reader-release.json"), JSON.stringify({ schema: 4, sha256: "a".repeat(64), buildId: "preview-build-1" }));
  assert.equal((await GET(new Request("http://localhost:30142/api/preview-build"))).status, 503);
  writeIdentity(target, { buildId: "drifted" });
  assert.equal((await GET(new Request("http://localhost:30142/api/preview-build"))).status, 503);
  const outside = join(parent, "pi-web-reader-test-30142");
  mkdirSync(outside, { recursive: true });
  writeIdentity(outside);
  rmSync(selector);
  symlinkSync(outside, selector);
  process.chdir(outside);
  assert.equal((await GET(new Request("http://localhost:30142/api/preview-build"))).status, 503);
});

test("preview-build requires the trusted launcher binding, not request URL port", async (t) => {
  const oldBoundPort = process.env.PI_WEB_BOUND_PORT;
  const oldPort = process.env.PORT;
  process.env.PORT = "30142";
  delete process.env.PI_WEB_BOUND_PORT;
  t.after(() => {
    if (oldBoundPort === undefined) delete process.env.PI_WEB_BOUND_PORT;
    else process.env.PI_WEB_BOUND_PORT = oldBoundPort;
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
  });
  // Without the launcher binding there is no build identity to report.
  assert.equal((await GET(new Request("http://localhost:30142/api/preview-build"))).status, 204);
  process.env.PI_WEB_BOUND_PORT = "30142";
  // The listener binding is trusted; an untrusted request URL port is ignored.
  assert.notEqual((await GET(new Request("http://localhost:30141/api/preview-build"))).status, 404);
  process.env.PI_WEB_BOUND_PORT = "30141";
  assert.notEqual((await GET(new Request("http://localhost:30142/api/reader/build"))).status, 404);
  process.env.PI_WEB_BOUND_PORT = "8080";
  assert.equal((await GET(new Request("http://localhost:30141/api/reader/build"))).status, 204);
});

test("an ordinary install on a channel port has no managed root and reports no identity", async (t) => {
  const keys = ["PI_WEB_INSTALL_DIR", "PI_WEB_BOUND_PORT"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-ordinary-install-")));
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_WEB_INSTALL_DIR = join(root, "missing");
  process.env.PI_WEB_BOUND_PORT = "30141";
  assert.equal((await GET(new Request("http://localhost:30141/api/reader/build"))).status, 204);
});

test("production checks current and never mistakes a newer preview for a production update", async (t) => {
  const oldCwd = process.cwd();
  const keys = ["PI_WEB_INSTALL_DIR", "PI_WEB_30142_SELECTOR", "PI_WEB_BOUND_PORT"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-production-build-")));
  const install = join(root, "install"), production = join(install, "releases", "production"), preview = join(install, "releases", "preview");
  writeIdentity(production, { readerCommit: "d".repeat(40) });
  writeIdentity(preview);
  const currentSelector = join(install, "current"), previewSelector = join(install, "preview-30142");
  symlinkSync(production, currentSelector);
  symlinkSync(preview, previewSelector);
  process.env.PI_WEB_INSTALL_DIR = install;
  process.env.PI_WEB_30142_SELECTOR = previewSelector;
  t.after(() => {
    process.chdir(oldCwd);
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  process.env.PI_WEB_BOUND_PORT = "30141";
  process.chdir(production);
  const response = await GET(new Request("http://localhost:30144/api/reader/build"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const identity = await response.json();
  assert.equal(identity.channel, "production");
  assert.equal(identity.installationPath, production);
  assert.equal(identity.readerCommit, "d".repeat(40));
  assert.equal((await routeModule.GET()).status, 200, "old pages retain their polling URL");
  process.env.PI_WEB_30142_SELECTOR = join(root, "missing-preview-selector");
  assert.equal((await GET()).status, 200, "production must not depend on the preview selector");

  process.env.PI_WEB_30142_SELECTOR = previewSelector;
  process.env.PI_WEB_BOUND_PORT = "30142";
  assert.equal((await GET()).status, 503, "a preview listener must not claim the production cwd");
  process.chdir(preview);
  const previewIdentity = await (await GET()).json();
  assert.equal(previewIdentity.channel, "preview");
  assert.equal(previewIdentity.readerCommit, "c".repeat(40));
  process.env.PI_WEB_BOUND_PORT = "30141";
  assert.equal((await GET()).status, 503, "a production listener must not claim the preview cwd");

  const outside = join(root, "outside-releases");
  writeIdentity(outside);
  rmSync(currentSelector);
  symlinkSync(outside, currentSelector);
  process.chdir(outside);
  assert.equal((await GET()).status, 503, "production retains the physical releases-root boundary");
});
