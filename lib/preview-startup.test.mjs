import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PREVIEW_SECRET_KEYS, rotatePreviewSecrets } = require("../bin/rotate-preview-secrets.js");
const { startPiWeb } = require("../bin/pi-web.js");

function createInstallFixture(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-web-preview-${label}-`)));
  const installRoot = path.join(root, "install");
  const releases = path.join(installRoot, "releases");
  const release = path.join(releases, "release-1");
  const nextDir = path.join(release, ".next");
  const selector = path.join(installRoot, "preview-30142");
  fs.mkdirSync(nextDir, { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.symlinkSync(release, selector, "dir");
  const manifestPath = path.join(nextDir, "prerender-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 4,
    routes: { "/": { initialRevalidateSeconds: false } },
    dynamicRoutes: {},
    preview: {
      previewModeId: "old-id",
      previewModeSigningKey: "old-signing",
      previewModeEncryptionKey: "old-encryption",
      preservedField: "keep-me",
    },
    notFoundRoutes: [],
  }, null, 2) + "\n");
  return { root, installRoot, release, selector, manifestPath };
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.unref = () => {};
  return child;
}

test("rotates all three preview values and preserves every other manifest field", (t) => {
  const fixture = createInstallFixture("rotate");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const before = readManifest(fixture.manifestPath);
  let generation = 0;

  rotatePreviewSecrets(fixture.manifestPath, {
    randomBytes: (size) => Buffer.alloc(size, ++generation),
    randomUUID: () => "rotation-one",
  });
  const first = readManifest(fixture.manifestPath);
  rotatePreviewSecrets(fixture.manifestPath, {
    randomBytes: (size) => Buffer.alloc(size, ++generation),
    randomUUID: () => "rotation-two",
  });
  const second = readManifest(fixture.manifestPath);

  assert.deepEqual({ ...first, preview: { preservedField: first.preview.preservedField } }, {
    ...before,
    preview: { preservedField: "keep-me" },
  });
  for (const key of PREVIEW_SECRET_KEYS) {
    assert.notEqual(first.preview[key], before.preview[key]);
    assert.notEqual(second.preview[key], first.preview[key]);
    assert.match(second.preview[key], /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(
    { version: second.version, routes: second.routes, dynamicRoutes: second.dynamicRoutes, notFoundRoutes: second.notFoundRoutes },
    { version: 4, routes: { "/": { initialRevalidateSeconds: false } }, dynamicRoutes: {}, notFoundRoutes: [] },
  );
  assert.deepEqual(fs.readdirSync(path.dirname(fixture.manifestPath)), ["prerender-manifest.json"]);
});

test("rotation failure leaves the old manifest and only cleans its own temp file", (t) => {
  const fixture = createInstallFixture("failure");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const before = fs.readFileSync(fixture.manifestPath);
  const originalRename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (path.resolve(String(to)) === path.resolve(fixture.manifestPath)) {
      const error = new Error("synthetic atomic replace failure");
      error.code = "EIO";
      throw error;
    }
    return originalRename(from, to);
  });
  try {
    assert.throws(
      () => rotatePreviewSecrets(fixture.manifestPath, {
        randomBytes: (size) => Buffer.alloc(size, 7),
        randomUUID: () => "failed-rotation",
      }),
      /synthetic atomic replace failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(fs.readFileSync(fixture.manifestPath), before);
  assert.deepEqual(fs.readdirSync(path.dirname(fixture.manifestPath)), ["prerender-manifest.json"]);
});

test("startup rotates the synthetic production install before the substituted spawn", (t) => {
  const fixture = createInstallFixture("startup");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let spawnCount = 0;
  const result = startPiWeb({
    args: ["--no-open", "--port", "30142"],
    env: {
      ...process.env,
      PI_WEB_INSTALL_DIR: fixture.installRoot,
      PI_WEB_30142_SELECTOR: fixture.selector,
    },
    packageDir: fixture.release,
    nextBin: "/synthetic/next/dist/bin/next",
    spawnImpl: () => {
      spawnCount += 1;
      return fakeChild();
    },
    wireLifecycle: () => {},
  });

  assert.equal(result.started, true);
  assert.equal(spawnCount, 1);
  assert.notEqual(readManifest(fixture.manifestPath).preview.previewModeId, "old-id");
});

test("missing and unwritable manifests fail closed before any spawn", (t) => {
  const fixture = createInstallFixture("write-gate");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    PI_WEB_INSTALL_DIR: fixture.installRoot,
    PI_WEB_30142_SELECTOR: fixture.selector,
  };
  let spawnCount = 0;
  fs.unlinkSync(fixture.manifestPath);
  const missing = startPiWeb({
    args: ["--no-open", "--port", "30142"],
    env,
    packageDir: fixture.release,
    nextBin: "/synthetic/next/dist/bin/next",
    spawnImpl: () => { spawnCount += 1; return fakeChild(); },
    wireLifecycle: () => {},
  });
  assert.equal(missing.started, false);
  assert.equal(spawnCount, 0);

  fs.writeFileSync(fixture.manifestPath, JSON.stringify({
    version: 4,
    routes: {},
    dynamicRoutes: {},
    preview: {
      previewModeId: "old-id",
      previewModeSigningKey: "old-signing",
      previewModeEncryptionKey: "old-encryption",
    },
  }));
  const before = fs.readFileSync(fixture.manifestPath);
  const originalOpen = fs.openSync;
  fs.openSync = ((filePath, ...args) => {
    if (String(filePath).includes(".upload.tmp") || String(filePath).includes(".prerender-manifest.json-")) {
      const error = new Error("synthetic permission failure");
      error.code = "EACCES";
      throw error;
    }
    return originalOpen(filePath, ...args);
  });
  try {
    const unwritable = startPiWeb({
      args: ["--no-open", "--port", "30142"],
      env,
      packageDir: fixture.release,
      nextBin: "/synthetic/next/dist/bin/next",
      spawnImpl: () => { spawnCount += 1; return fakeChild(); },
      wireLifecycle: () => {},
    });
    assert.equal(unwritable.started, false);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(spawnCount, 0);
  assert.deepEqual(fs.readFileSync(fixture.manifestPath), before);
});

test("browser URLs use a reachable local address without changing listener bindings", (t) => {
  const fixture = createInstallFixture("browser-url");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  for (const [hostname, browserHost] of [
    ["0.0.0.0", "127.0.0.1"], ["::", "[::1]"], ["[::]", "[::1]"],
    ["::1", "[::1]"], ["127.0.0.1", "127.0.0.1"], ["reader.example", "reader.example"],
  ]) {
    const calls = [], child = fakeChild();
    const result = startPiWeb({
      args: ["--port", "30141", "--hostname", hostname], env: {}, packageDir: fixture.release,
      nextBin: "/synthetic/next", rotateSecrets() {}, wireLifecycle() {},
      processImpl: { execPath: process.execPath, platform: "darwin", env: {}, stdout: { write() {} } },
      spawnImpl(command, args, options) { calls.push({ command, args, options }); return calls.length === 1 ? child : fakeChild(); },
    });
    assert.equal(result.started, true);
    child.stdout.emit("data", Buffer.from("Ready"));
    child.stdout.emit("data", Buffer.from("Ready again"));
    assert.equal(calls.length, 2, "one startup opens at most one browser tab");
    assert.equal(calls[0].args.at(-1), hostname);
    assert.equal(calls[0].options.env.PI_WEB_HOSTNAME, hostname);
    assert.equal(calls[1].command, "open");
    assert.deepEqual(calls[1].args, [`http://${browserHost}:30141`]);
  }
});

test("managed no-open startup never opens a browser after Ready", (t) => {
  const fixture = createInstallFixture("no-open");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  for (const options of [{ args: ["--no-open"], env: {} }, { args: [], env: { PI_WEB_NO_OPEN: "1" } }]) {
    const child = fakeChild(), calls = [];
    startPiWeb({
      ...options, packageDir: fixture.release, nextBin: "/synthetic/next", rotateSecrets() {}, wireLifecycle() {},
      processImpl: { execPath: process.execPath, platform: "darwin", env: {}, stdout: { write() {} } },
      spawnImpl(command, args) { calls.push({ command, args }); return child; },
    });
    child.stdout.emit("data", Buffer.from("Ready"));
    assert.equal(calls.length, 1);
  }
});

test("missing or damaged preview protection refuses startup without spawning", (t) => {
  const fixture = createInstallFixture("blocked");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const before = fs.readFileSync(fixture.manifestPath);
  const malformed = JSON.stringify({ version: 4, routes: {}, dynamicRoutes: {} }) + "\n";
  fs.writeFileSync(fixture.manifestPath, malformed);
  let spawnCount = 0;

  const result = startPiWeb({
    args: ["--no-open", "--port", "30142"],
    env: {
      ...process.env,
      PI_WEB_INSTALL_DIR: fixture.installRoot,
      PI_WEB_30142_SELECTOR: fixture.selector,
    },
    packageDir: fixture.release,
    nextBin: "/synthetic/next/dist/bin/next",
    spawnImpl: () => {
      spawnCount += 1;
      return fakeChild();
    },
    wireLifecycle: () => {},
  });

  assert.equal(result.started, false);
  assert.match(result.error, /refusing to start/);
  assert.equal(spawnCount, 0);
  assert.deepEqual(fs.readFileSync(fixture.manifestPath), Buffer.from(malformed));
  assert.doesNotMatch(result.error, /old-id|old-signing|old-encryption/);
  assert.notDeepEqual(before, fs.readFileSync(fixture.manifestPath));
});
